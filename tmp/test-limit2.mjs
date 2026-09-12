import { config } from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

config();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" });

async function run() {
  try {
    for (let i = 0; i < 25; i++) {
      const res = await model.generateContent("Say 'hello'");
      process.stdout.write(".");
      await new Promise(r => setTimeout(r, 4000));
    }
    console.log("\nSuccess!");
  } catch (err) {
    console.error("\nError:", err.message);
  }
}
run();
