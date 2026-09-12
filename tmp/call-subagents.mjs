import fs from 'fs';
const data = JSON.parse(fs.readFileSync('tmp/subagents-50.json', 'utf8'));

// Format it so I can just copy it mentally.
for (let i = 0; i < data.Subagents.length; i++) {
  const sa = data.Subagents[i];
  console.log(`Subagent ${i}:`);
  console.log(sa.Prompt.split('\n\n')[1]);
}
