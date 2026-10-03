// Suggests topic tags for a page. This is a local keyword stand-in until Marked
// calls TypeSafe's Jev model, and it returns the same shape Jev's yes/no
// ("Noul") questions give: a probability per tag. Nothing leaves the device.
const normalize = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const KEYWORDS = {
  technology: ['technology', 'tech', 'software', 'hardware', 'computer', 'computers', 'computing', 'programming', 'developer', 'developers', 'code', 'coding', 'api', 'apis', 'web', 'internet', 'app', 'apps', 'database', 'server', 'cloud', 'linux', 'open source', 'engineering', 'javascript', 'python', 'browser', 'gadget', 'gadgets'],
  ai: ['ai', 'artificial intelligence', 'machine learning', 'deep learning', 'neural network', 'neural networks', 'llm', 'llms', 'language model', 'language models', 'gpt', 'transformer', 'transformers', 'reinforcement learning', 'world model', 'world models', 'chatbot', 'chatbots', 'openai', 'anthropic', 'hugging face'],
  history: ['history', 'historical', 'historian', 'ancient', 'medieval', 'century', 'centuries', 'empire', 'dynasty', 'revolution', 'archaeology', 'civilization', 'world war', 'renaissance', 'colonial'],
  fiction: ['fiction', 'novel', 'novels', 'novella', 'short story', 'short stories', 'fantasy', 'science fiction', 'sci fi', 'fan fiction', 'fanfiction']
};
const DOMAINS = {
  technology: ['github.com', 'stackoverflow.com', 'developer.mozilla.org', 'news.ycombinator.com'],
  ai: ['huggingface.co', 'openai.com', 'anthropic.com'],
  fiction: ['goodreads.com', 'archiveofourown.org', 'fanfiction.net', 'royalroad.com', 'wattpad.com']
};

// page: { title, url, abstract }; tags: the user's tag list.
// Resolves to [{ tag, probability }], most likely first.
export async function suggestTags(page, tags) {
  const title = ` ${normalize(page.title)} `, abstract = ` ${normalize(page.abstract)} `;
  let host = '';
  try { host = new URL(page.url).hostname.replace(/^www\./, ''); } catch {}
  return tags.map(tag => {
    const key = normalize(tag);
    // Tags without a keyword list match their own name and its plural.
    const words = KEYWORDS[key] || [key, `${key}s`];
    let score = 0;
    for (const word of words) {
      if (title.includes(` ${word} `)) score += 2;
      else if (abstract.includes(` ${word} `)) score += 1;
    }
    if ((DOMAINS[key] || []).some(domain => host === domain || host.endsWith(`.${domain}`))) score += 2;
    return { tag, probability: score / (score + 2) };
  }).sort((a, b) => b.probability - a.probability);
}

// Keeps likely tags: a title or domain match, or two abstract matches.
export function chooseTags(scores, { threshold = 0.5, max = 3 } = {}) {
  return scores.filter(score => score.probability >= threshold).slice(0, max).map(score => score.tag);
}
