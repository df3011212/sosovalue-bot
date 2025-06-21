/* -------------------------------------------------
   SoSoValue 研究文章自動推播（含作者/標籤）
   ------------------------------------------------- */
require('dotenv').config();               // ← 讀 .env

const puppeteer = require('puppeteer');
const axios     = require('axios');
const fs        = require('fs');
const cron      = require('node-cron');

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LAST_ID_FILE     = 'last_article_id.txt';

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('⛔️ TELEGRAM_TOKEN / TELEGRAM_CHAT_ID 尚未設定！');
  process.exit(1);
}

/* ---------- Telegram ---------- */
async function sendTelegram(text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('❌ 發送 Telegram 失敗：', err?.response?.data || err.message);
  }
}

/* ---------- 檔案 ---------- */
const getLastId  = () => (fs.existsSync(LAST_ID_FILE) ? fs.readFileSync(LAST_ID_FILE, 'utf8').trim() : '');
const saveLastId = id  => fs.writeFileSync(LAST_ID_FILE, id, 'utf8');

/* ---------- 擷取文章 ---------- */
async function scrapeArticles() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
      'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );
    await page.goto('https://sosovalue.com/tc/research', { waitUntil: 'networkidle2', timeout: 0 });

    /* --- 滾到最底，直到穩定 --- */
    let prev = 0, stable = 0;
    while (stable < 3) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(r => setTimeout(r, 1500));
      const cur = await page.evaluate(() => document.querySelectorAll('li.MuiTimelineItem-root').length);
      if (cur === prev) stable++; else { prev = cur; stable = 0; }
    }

    const todayStr = new Date().toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
                     .replace('/', '月') + '日';

    /* --- 解析文章列 --- */
    const rows = await page.evaluate(today => {
      const items = Array.from(document.querySelectorAll('li.MuiTimelineItem-root'));
      return items.map(li => {
        /* 時間 / 標題 / 連結 / ID */
        const when  = li.innerText.match(/^\s*\d+\s*(秒|分鐘|小時)前|[0-9]+月[0-9]+日/)?.[0] || '';
        const a     = li.querySelector('a[href^="/tc/news/"]');
        const title = li.querySelector('div.font-bold')?.innerText.trim();
        const href  = a?.getAttribute('href') || '';
        const id    = href.match(/(\d{18,})/)?.[1] || '';

        /* 作者與標籤 → Hashtag 集合 */
        const hashSet = new Set();

        /* 作者 */
        const author = li.querySelector('span.text-neutral-fg-3-rest')?.innerText.trim();
        if (author) hashSet.add('#' + author.replace(/\s+/g, ''));

        /* 文章自帶標籤 */
        li.querySelectorAll('div.flex a').forEach(node => {
          const raw = node.innerText.trim();
          if (!raw) return;
          if (raw.startsWith('$')) {                 // $BTC → #BTC
            hashSet.add('#' + raw.slice(1).replace(/\./g, '').toUpperCase());
          } else if (raw.startsWith('#')) {          // #Bitcoin → #Bitcoin
            hashSet.add(raw.replace(/\s+/g, ''));
          }
        });

        return {
          id,
          title,
          url: `https://sosovalue.com/tc/research/${id}`,
          when,
          hashtags: Array.from(hashSet)
        };
      })
      .filter(x => x.title && x.id && x.when && (x.when.includes('前') || x.when.includes(today)));
    }, todayStr);

    return rows;
  } finally {
    await browser.close();
  }
}

/* ---------- 第一次啟動：推送今天全部文章 ---------- */
async function sendTodayBatch() {
  const articles = await scrapeArticles();
  if (!articles.length) { console.log('⚠️ 今天沒有文章'); return; }

  for (let i = 0; i < articles.length; i += 20) {
    const chunk = articles.slice(i, i + 20);
    const msg =
      `📢 *今天 24 小時內研究文章（${i + 1}–${i + chunk.length}）*\n\n` +
      chunk.map((a, j) => {
        const tags = a.hashtags.length ? '\n' + a.hashtags.join(' ') : '';
        return `*${i + j + 1}. ${a.title}*${tags}\n🔗 ${a.url}`;
      }).join('\n\n');
    await sendTelegram(msg);
    console.log(`✅ 首次推送 ${i + 1}–${i + chunk.length}`);
    await new Promise(r => setTimeout(r, 1000));
  }
  saveLastId(articles[0].id);
}

/* ---------- 後續檢查：推送所有未發送文章 ---------- */
async function checkAndSendAllNew() {
  const articles = await scrapeArticles();
  if (!articles.length) return console.log('⚠️ 沒抓到任何文章');

  const lastId = getLastId();
  const newArticles = [];

  for (const a of articles) {
    if (a.id === lastId) break;
    newArticles.push(a);
  }

  if (!newArticles.length) return console.log('⏸️ 沒有新文章，跳過推播');

  for (let i = newArticles.length - 1; i >= 0; i--) {
    const a = newArticles[i];
    const tags = a.hashtags.length ? '\n' + a.hashtags.join(' ') : '';
    await sendTelegram(`📢 *SoSoValue 新文章*\n\n*${a.title}*${tags}\n🔗 ${a.url}`);
    console.log(`✅ 已推送：${a.title}`);
    await new Promise(r => setTimeout(r, 1000));
  }

  saveLastId(newArticles[0].id);
}

/* ---------- 主流程 ---------- */
(async () => {
  console.log('🚀 第一次啟動，推送今日文章清單…');
  await sendTodayBatch();

  console.log('📅 排程啟動：每 15 分檢查一次');
  cron.schedule('*/15 * * * *', async () => {
    console.log('\n🔍 定時檢查新文章…', new Date().toLocaleString());
    try {
      await checkAndSendAllNew();
    } catch (err) {
      console.error('❌ 檢查出錯：', err.message);
    }
  });
})();
