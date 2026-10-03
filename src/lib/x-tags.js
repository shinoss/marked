// Tagging posts imported from X with Jev (jev.js), with the user's own TypeSafe
// API key, and only when they choose it for an import. Each request holds a
// batch of posts in its state and asks, for every post and every tag, whether
// the tag fits the post: a checklist of Nouls, which Jev answers in parallel.
// Each post gets the tags that fit it best.

// A tag fits when Jev gives it at least even odds; a post keeps its best few.
export const TAG_FITS = 0.5;
export const TAGS_PER_POST = 3;
// Every post asks about every tag, so the more tags, the fewer posts per request.
const QUESTIONS_PER_REQUEST = 400;
export const tagBatch = tags => Math.max(1, Math.min(20, Math.floor(QUESTIONS_PER_REQUEST / Math.max(1, tags.length))));

const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const questionId = (post, tag) => `p${post}t${tag}`;
const CRITERIA = {
  true: 'The post is about what the tag names, or plainly belongs under it',
  false: 'The post has little or nothing to do with what the tag names'
};

// What the parts of each post are, said once in the state rather than in every question.
const ABOUT_POSTS = 'Each post is from X. A post may quote another post (quoted_post), describe its images (image_descriptions), or preview a page it links to (link_preview); all of it is part of what the post is about.';

// One request for posts ([{ url, text, quote, images, link }], the last three
// when the post has them) and tags: { state, questions }. Who posted it says
// nothing of what it's about, so no names go, the quoted post's either. Each
// question names its post's place in the state, so Jev reads that post alone.
export function tagRequest(tags, posts) {
  const state = { about: ABOUT_POSTS, posts: posts.map(post => ({
    text: clean(post.text, 500),
    ...(clean(post.quote?.text) && { quoted_post: clean(post.quote.text, 300) }),
    ...(post.images?.length && { image_descriptions: post.images.slice(0, 4).map(image => clean(image, 200)) }),
    ...(post.link && { link_preview: clean(post.link, 300) })
  })) };
  const questions = {};
  posts.forEach((_, post) => tags.forEach((tag, index) => {
    questions[questionId(post, index)] = { type: 'noul', instructions: `Does the tag “${clean(tag, 100)}” fit the post in \`posts[${post}]\`?`, criteria: CRITERIA };
  }));
  return { state, questions };
}

// Each post's tags from Jev's answers, best first: { url: [tag] }, leaving out
// posts no tag fits, and every post of a preview, which answers nothing.
export function tagAnswers(tags, posts, answers) {
  const chosen = {};
  posts.forEach((post, index) => {
    const fits = tags.map((tag, t) => [tag, Number(answers?.[questionId(index, t)]?.noul)])
      .filter(([, noul]) => noul >= TAG_FITS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TAGS_PER_POST)
      .map(([tag]) => tag);
    if (fits.length) chosen[post.url] = fits;
  });
  return chosen;
}
