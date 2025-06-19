/* -------------------------------------------------
   SoSoValue 研究文章自動推播
   1. 啟動時  → 推送今天 24h 內全部文章（分批）
   2. 之後每 15 分 → 只要有新文章就即時推播 1 篇
   ------------------------------------------------- */
const puppeteer = require('puppeteer');
const axios     = require('axios');
const fs        = require('fs');
const cron      = require('node-cron');

const TELEGRAM_TOKEN   = '8041117241:AAG-9fljUbFSP-YHMcAfAHXcAKtw9eIFqvk';

/* ★★★ 改成超級群組 ID ★★★ */
const TELEGRAM_CHAT_ID = '-1002744302166';

const LAST_ID_FILE     = 'last_article_id.txt';

/* -------------- Telegram ---------------- */
async function sendTelegram(text) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }
  );
}

/* -------------- 儲存 / 讀取上次推播 ID ------------- */
function getLastId()   {
  return fs.existsSync(LAST_ID_FILE)
           ? fs.readFileSync(LAST_ID_FILE, 'utf-8').trim()
           : '';
}
function saveLastId(id){ fs.writeFileSync(LAST_ID_FILE, id, 'utf-8'); }

/* -------------- 抓取頁面並回傳所有文章 -------------- */
async function scrapeArticles() {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page    = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  );

  await page.goto('https://sosovalue.com/tc/research', {
    waitUntil: 'networkidle2', timeout: 0
  });

  /* ➜ 無限滾動直到內容穩定三次 */
  let prev = 0, stable = 0;
  while (stable < 3) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 1500));
    const cur = await page.evaluate(
      () => document.querySelectorAll('li.MuiTimelineItem-root').length
    );
    if (cur === prev) stable++; else { prev = cur; stable = 0; }
  }

  /* ➜ 今天日期字串（6月19日） */
  const todayStr = new Date().toLocaleDateString('zh-TW',
                     { month: 'numeric', day: 'numeric' })
                     .replace('/', '月') + '日';

  /* ➜ 擷取符合今天 / 24h 文章 */
  const list = await page.evaluate(today => {
    const rows = Array.from(document.querySelectorAll('li.MuiTimelineItem-root'));
    return rows.map(li => {
      const when  = li.innerText.match(/^\s*\d+\s*(秒|分鐘|小時)前|[0-9]+月[0-9]+日/)?.[0] || '';
      const a     = li.querySelector('a[href^="/tc/news/"]');
      const title = li.querySelector('div.font-bold')?.innerText.trim();
      const href  = a?.getAttribute('href') || '';            // /tc/news/123...
      const id    = href.match(/(\d{18,})/)?.[1] || '';
      return { title, id, href, when };
    }).filter(x =>
      x.title && x.id && (x.when.includes('前') || x.when.includes(today))
    );
  }, todayStr);

  await browser.close();

  return list.map(x => ({
    id: x.id,
    title: x.title,
    url: `https://sosovalue.com/tc/research/${x.id}`
  }));
}

/* -------------- 第一次：推送今天全部文章 ------------- */
async function sendTodayBatch() {
  const articles = await scrapeArticles();
  if (!articles.length) { console.log('⚠️ 今天沒有文章'); return; }

  for (let i = 0; i < articles.length; i += 20) {
    const batch = articles.slice(i, i + 20);
    const msg =
      `📢 *今天 24 小時內研究文章（${i + 1}–${i + batch.length}）*\n\n` +
      batch.map((a, j) =>
        `*${i + j + 1}. ${a.title}*\n🔗 ${a.url}`
      ).join('\n\n');
    await sendTelegram(msg);
    console.log(`✅ 首次推送 ${i + 1}–${i + batch.length}`);
    await new Promise(r => setTimeout(r, 1000)); // 避免限流
  }
  saveLastId(articles[0].id);          // 記下最新 ID
}

/* -------------- 後續：只推送最新 1 篇 --------------- */
async function checkAndSendLatest() {
  const articles = await scrapeArticles();
  if (!articles.length) { console.log('⚠️ 沒抓到任何文章'); return; }

  const newest = articles[0];
  const lastId = getLastId();
  if (newest.id === lastId) {
    console.log('⏸️ 沒有新文章，跳過推播');
    return;
  }
  const msg = `📢 *SoSoValue 新文章*\n\n*${newest.title}*\n🔗 ${newest.url}`;
  await sendTelegram(msg);
  console.log(`✅ 新文章已推送：${newest.title}`);
  saveLastId(newest.id);
}

/* -------------- 主流程 ----------------------------- */
(async () => {
  console.log('🚀 第一次啟動，推送今日文章清單…');
  await sendTodayBatch();

  console.log('📅 排程啟動：每 15 分鐘檢查一次');
  cron.schedule('*/15 * * * *', async () => {
    console.log('\n🔍 定時檢查新文章…', new Date().toLocaleString());
    try {
      await checkAndSendLatest();
    } catch (err) {
      console.error('❌ 檢查過程出錯：', err.message);
    }
  });
})();
