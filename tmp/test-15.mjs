import { config } from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

config();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function run() {
  try {
    const res = await model.generateContent("Hello!");
    console.log(res.response.text());
  } catch (err) {
    console.error(err.message);
  }
}
run();
