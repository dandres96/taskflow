// Test API endpoints
const BASE = 'http://0.0.0.0:3000';

async function test() {
  // Login
  const loginRes = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@taskflow.local', password: 'admin123' })
  });
  const login = await loginRes.json();
  console.log('Login:', loginRes.status, JSON.stringify(login).substring(0, 100));
  
  if (!login.token) { console.log('FAIL: no token'); return; }
  
  const auth = { Authorization: 'Bearer ' + login.token };
  
  // Get tasks
  const tasksRes = await fetch(BASE + '/api/tasks', { headers: auth });
  const tasks = await tasksRes.json();
  console.log('Tasks:', tasksRes.status, Array.isArray(tasks) ? tasks.length + ' tasks' : JSON.stringify(tasks));
  
  // Create task
  const createRes = await fetch(BASE + '/api/tasks', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Test from server', priority: 'high' })
  });
  const created = await createRes.json();
  console.log('Create:', createRes.status, JSON.stringify(created).substring(0, 150));
  
  // Get tasks again
  const tasksRes2 = await fetch(BASE + '/api/tasks', { headers: auth });
  const tasks2 = await tasksRes2.json();
  console.log('Tasks after create:', tasksRes2.status, tasks2.length + ' tasks');
}

test().catch(e => console.log('ERROR:', e.message));
