import { config } from 'dotenv';
config();
async function run() {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
  const json = await res.json();
  if (json.models) {
    json.models.forEach(m => console.log(m.name));
  } else {
    console.log(json);
  }
}
run();
