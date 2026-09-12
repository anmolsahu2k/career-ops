import urllib.request
from bs4 import BeautifulSoup
import json
import sys

urls = [
    "https://job-boards.greenhouse.io/dialpad/jobs/8701282002",
    "https://jobs.ashbyhq.com/deepgram/8fd3acd1-31c0-4dad-a249-a8d3d5d79cc9",
    "https://jobs.ashbyhq.com/sierra/149f368c-52d5-408f-ba26-ad888f318a00",
    "https://jobs.ashbyhq.com/sierra/1d5cf6f0-feba-46a6-98bc-70a1627a76d0",
    "https://jobs.ashbyhq.com/decagon/5433ff3a-9a7c-406b-9dd8-23094141b907"
]

for i, url in enumerate(urls):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        html = urllib.request.urlopen(req).read()
        soup = BeautifulSoup(html, 'html.parser')
        text = soup.get_text(separator='\n', strip=True)
        with open(f"jd_{i}.txt", "w") as f:
            f.write(text)
        print(f"Success {i}")
    except Exception as e:
        print(f"Error {i}: {e}")
