const { execSync } = require('child_process');
const cmd = `sed -i 's/app.listen(PORT, ()/app.listen(PORT, \"0.0.0.0\", ()/' server.js`;
console.log('Running:', cmd);
try {
  const result = execSync('flyctl ssh console --app taskflow-daniel -C "' + cmd.replace(/"/g, '\\"') + '"', { encoding: 'utf8', timeout: 30000, stdio: ['pipe','pipe','pipe'] });
  console.log('OUT:', result);
} catch(e) {
  console.log('ERR:', e.stderr || e.message);
}

// Verify
try {
  const result2 = execSync('flyctl ssh console --app taskflow-daniel -C "grep listen server.js"', { encoding: 'utf8', timeout: 30000, stdio: ['pipe','pipe','pipe'] });
  console.log('VERIFY:', result2);
} catch(e) {
  console.log('VERIFY ERR:', e.stderr || e.message);
}
