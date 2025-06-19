require('dotenv').config();

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

async function sendTelegram(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error('❌ 發送 Telegram 失敗：', err?.response?.data || err.message);
  }
}

const getLastId  = () => (fs.existsSync(LAST_ID_FILE) ? fs.readFileSync(LAST_ID_FILE, 'utf8').trim() : '');
const saveLastId = id  => fs.writeFileSync(LAST_ID_FILE, id, 'utf8');

async function scrapeArticles() {
  const isRender = process.env.RENDER === 'true';

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: isRender ? '/opt/render/.cache/puppeteer/chrome/linux-137.0.7151.119/chrome-linux64/chrome' : undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-zygote',
      '--single-process'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );

    await page.goto('https://sosovalue.com/tc/research', {
      waitUntil: 'networkidle2',
      timeout: 0
    });

    let prev = 0, stable = 0;
    while (stable < 3) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      const cur = await page.evaluate(
        () => document.querySelectorAll('li.MuiTimelineItem-root').length
      );
      if (cur === prev) stable++; else { prev = cur; stable = 0; }
    }

    const todayStr = new Date().toLocaleDateString('zh-TW', {
      month: 'numeric', day: 'numeric'
    }).replace('/', '月') + '日';

    const rows = await page.evaluate(today => {
      const items = Array.from(document.querySelectorAll('li.MuiTimelineItem-root'));
      return items.map(li => {
        const when  = li.innerText.match(/^\s*\d+\s*(秒|分鐘|小時)前|[0-9]+月[0-9]+日/)?.[0] || '';
        const a     = li.querySelector('a[href^="/tc/news/"]');
        const title = li.querySelector('div.font-bold')?.innerText.trim();
        const href  = a?.getAttribute('href') || '';
        const id    = href.match(/(\d{18,})/)?.[1] || '';
        return { title, id, when };
      }).filter(x =>
        x.title && x.id && (x.when.includes('前') || x.when.includes(today))
      );
    }, todayStr);

    return rows.map(r => ({
      id:    r.id,
      title: r.title,
      url:   `https://sosovalue.com/tc/research/${r.id}`
    }));
  } finally {
    await browser.close();
  }
}

async function sendTodayBatch() {
  const articles = await scrapeArticles();
  if (!articles.length) return console.log('⚠️ 今天沒有文章');

  for (let i = 0; i < articles.length; i += 20) {
    const chunk = articles.slice(i, i + 20);
    const msg =
      `📢 *今天 24 小時內研究文章（${i + 1}–${i + chunk.length}）*\n\n` +
      chunk.map((a, j) => `*${i + j + 1}. ${a.title}*\n🔗 ${a.url}`).join('\n\n');
    await sendTelegram(msg);
    console.log(`✅ 首次推送 ${i + 1}–${i + chunk.length}`);
    await new Promise(r => setTimeout(r, 1000));
  }
  saveLastId(articles[0].id);
}

async function checkAndSendLatest() {
  const articles = await scrapeArticles();
  if (!articles.length) return console.log('⚠️ 沒抓到任何文章');

  const newest = articles[0];
  const lastId = getLastId();
  if (newest.id === lastId) return console.log('⏸️ 沒有新文章，跳過推播');

  await sendTelegram(`📢 *SoSoValue 新文章*\n\n*${newest.title}*\n🔗 ${newest.url}`);
  console.log(`✅ 新文章已推送：${newest.title}`);
  saveLastId(newest.id);
}

(async () => {
  console.log('🚀 第一次啟動，推送今日文章清單…');
  await sendTodayBatch();

  console.log('📅 排程啟動：每 15 分檢查一次');
  cron.schedule('*/15 * * * *', async () => {
    console.log('\n🔍 定時檢查新文章…', new Date().toLocaleString());
    try {
      await checkAndSendLatest();
    } catch (err) {
      console.error('❌ 檢查出錯：', err.message);
    }
  });
})();
