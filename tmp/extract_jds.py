import json, re, glob, os
from bs4 import BeautifulSoup
for f in sorted(glob.glob("tmp/jd*.html")):
    html = open(f).read()
    soup = BeautifulSoup(html, "html.parser")
    # For schema.org/JobPosting
    job = {}
    for script in soup.find_all('script', type='application/ld+json'):
        try:
            data = json.loads(script.string)
            if isinstance(data, dict) and data.get('@type') == 'JobPosting':
                job = data
        except: pass
    
    title = job.get('title')
    desc = job.get('description')
    if not desc:
        # greenhouse often has a div id="content" or something similar
        content_div = soup.find('div', id='content') or soup.find('div', class_='content')
        if content_div:
            desc = content_div.get_text(separator='\n').strip()
        else:
            desc = soup.body.get_text(separator='\n').strip() if soup.body else ""
    if not title:
        title = soup.title.string if soup.title else ""
        
    print(f"=== FILE: {f} ===")
    print(f"TITLE: {title}")
    # Truncate desc to not spam the context too much
    # Wait, I need the full JD to evaluate, maybe write to a clean txt file
    with open(f.replace('.html', '.txt'), 'w') as out:
        out.write(f"TITLE: {title}\nDESC:\n{desc}\n")
    print(f"Wrote {f.replace('.html', '.txt')} ({len(desc)} chars)")
