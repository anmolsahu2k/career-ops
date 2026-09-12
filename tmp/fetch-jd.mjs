import https from 'https';
import http from 'http';

const url = process.argv[2];
if (!url) {
  console.error("Usage: node fetch-jd.mjs <url>");
  process.exit(1);
}

const lib = url.startsWith('https') ? https : http;
const req = lib.get(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  }
}, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => console.log(data));
});

req.on('error', (e) => {
  console.error(e);
  process.exit(1);
});
