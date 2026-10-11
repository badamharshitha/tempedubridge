import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 5501;
const base = `http://127.0.0.1:${port}/api`;
let server;
let adminCookie;
let sponsorCookie;
let volunteerCookie;

async function request(path, options = {}, cookie) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${body.message}`);
  return { body, headers: response.headers };
}
function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';')[0];
}
async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await fetch(`${base}/health`); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('Test server did not start.');
}

before(async () => {
  server = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'development', DEMO_MODE: 'true', PORT: String(port) }, stdio: 'ignore' });
  await waitForServer();
});
after(() => server?.kill('SIGTERM'));

test('complete volunteer, sponsor, admin and support workflow', async () => {
  const stamp = Date.now();
  const volunteer = await request('/auth/register', { method: 'POST', body: JSON.stringify({ name: 'Workflow Volunteer', email: `workflow-vol-${stamp}@example.com`, password: 'EduBridgeTest2026!', role: 'VOLUNTEER' }) });
  volunteerCookie = cookieFrom(volunteer);
  const volunteerId = volunteer.body.data.user.id;
  assert.equal(volunteer.body.data.user.role, 'VOLUNTEER');

  const admin = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@edubridge.demo', password: 'EduBridge2026!' }) });
  adminCookie = cookieFrom(admin);
  await request('/verification', { method: 'POST', body: JSON.stringify({ idType: 'National ID', location: 'Nairobi' }) }, volunteerCookie);
  await request(`/admin/volunteers/${volunteerId}`, { method: 'PATCH', body: JSON.stringify({ status: 'APPROVED' }) }, adminCookie);

  const student = await request('/students', { method: 'POST', body: JSON.stringify({ name: 'Workflow Student', age: 15, school: 'Workflow Academy', academicPerformance: 78, familyIncome: 3500, familySize: 6, location: 'Nairobi', financialCondition: 'Severe', educationalNeed: 'high', dropoutRisk: 'high', supportCategory: 'Tuition Fee', requiredAmount: 40000, description: 'Workflow test student.' }) }, volunteerCookie);
  const studentId = student.body.data.id;
  assert.ok(student.body.data.needScore >= 0 && student.body.data.needScore <= 100);
  assert.equal(typeof student.body.data.aiExplanation, 'string');
  await request(`/admin/students/${studentId}`, { method: 'PATCH', body: JSON.stringify({ status: 'APPROVED' }) }, adminCookie);

  const sponsor = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'sponsor@edubridge.demo', password: 'EduBridge2026!' }) });
  sponsorCookie = cookieFrom(sponsor);
  const cappedProfile = await request('/profile', { method: 'PATCH', body: JSON.stringify({ budget: 150000 }) }, sponsorCookie);
  assert.equal(cappedProfile.body.data.profile.budget, 100000);
  const recommendations = await request('/recommendations/students', {}, sponsorCookie);
  assert.ok(recommendations.body.data.some(item => item.id === studentId));
  const support = await request('/support', { method: 'POST', body: JSON.stringify({ studentId, amount: 40000 }) }, sponsorCookie);
  const supportId = support.body.data.id;
  const review = await request('/admin/support', {}, adminCookie);
  assert.equal(review.body.data.find(item => item.id === supportId).student.id, studentId);
  assert.equal(review.body.data.find(item => item.id === supportId).sponsor.name, 'Northstar Foundation');
  assert.equal(support.body.data.status, 'COMPLETED');
  assert.equal((await request('/support', {}, sponsorCookie)).body.data.find(item => item.id === supportId).status, 'COMPLETED');
  await assert.rejects(() => request('/admin/support', {}, sponsorCookie), /403/);
  await assert.rejects(() => request('/support', { method: 'POST', body: JSON.stringify({ studentId, amount: 40000 }) }, sponsorCookie), /409/);
  await assert.rejects(() => request(`/admin/support/${supportId}`, { method: 'PATCH', body: JSON.stringify({ status: 'REJECTED' }) }, adminCookie), /404/);

  const secondStudent = await request('/students', { method: 'POST', body: JSON.stringify({ name: 'Rejected Workflow Student', age: 16, school: 'Workflow Academy', academicPerformance: 74, familyIncome: 4200, familySize: 5, location: 'Nairobi', financialCondition: 'Severe', educationalNeed: 'high', dropoutRisk: 'high', supportCategory: 'Tuition Fee', requiredAmount: 40000, description: 'Rejected workflow test student.' }) }, volunteerCookie);
  const secondStudentId = secondStudent.body.data.id;
  await request(`/admin/students/${secondStudentId}`, { method: 'PATCH', body: JSON.stringify({ status: 'APPROVED' }) }, adminCookie);
  await request('/profile', { method: 'PATCH', body: JSON.stringify({ budget: 30000 }) }, sponsorCookie);
  await assert.rejects(() => request('/support', { method: 'POST', body: JSON.stringify({ studentId: secondStudentId, amount: 40000 }) }, sponsorCookie), /422/);
  await request('/profile', { method: 'PATCH', body: JSON.stringify({ budget: 100000 }) }, sponsorCookie);
  const rejectedSupport = await request('/support', { method: 'POST', body: JSON.stringify({ studentId: secondStudentId, amount: 40000 }) }, sponsorCookie);
  assert.equal(rejectedSupport.body.data.status, 'COMPLETED');

  const sponsorSupport = await request('/support', {}, sponsorCookie);
  const volunteerSupport = await request('/support', {}, volunteerCookie);
  const audits = await request('/admin/audit-logs', {}, adminCookie);
  assert.equal(sponsorSupport.body.data.find(item => item.id === supportId).status, 'COMPLETED');
  assert.equal(volunteerSupport.body.data.find(item => item.id === supportId).status, 'COMPLETED');
  assert.ok(audits.body.data.some(item => item.entityType === 'SupportRequest'));
});
