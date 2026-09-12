import sys
import urllib.request
import urllib.error

url = sys.argv[1]
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'})
try:
    with urllib.request.urlopen(req) as response:
        html = response.read().decode('utf-8', errors='ignore')
        with open('tmp/last_jd.html', 'w', encoding='utf-8') as f:
            f.write(html)
        print(html)
except urllib.error.URLError as e:
    print(f"Error fetching {url}: {e}", file=sys.stderr)
    sys.exit(1)
