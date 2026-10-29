// Usage: ANTHROPIC_API_KEY=... node example/run.js <export.csv> <loginId> [postLimit]
const fs = require('fs');
const { csvTextToPostData, filterToAccount, limitPosts } = require('../src/postData.csv');
const { runBrandGuide } = require('../src/runBrandGuide');

(async () => {
  const [csvPath, accountId, limit = '20'] = process.argv.slice(2);
  if (!csvPath || !accountId || !process.env.ANTHROPIC_API_KEY) {
    console.error('Usage: ANTHROPIC_API_KEY=... node example/run.js <export.csv> <loginId> [postLimit]');
    process.exit(1);
  }
  const all = filterToAccount(csvTextToPostData(fs.readFileSync(csvPath, 'utf8')), accountId);
  const postData = { ...all, posts: limitPosts(all.posts, Number(limit)) };
  // optional ground truth: postData.account_info.brand_name = '...'; postData.account_info.website = 'https://...';
  const result = await runBrandGuide({ postData, apiKey: process.env.ANTHROPIC_API_KEY });
  console.log(JSON.stringify(result, null, 2));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
