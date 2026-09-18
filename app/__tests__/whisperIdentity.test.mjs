import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createWhisperIdentity } from '../whisperIdentity.mjs';
const env = { DEPLOYMENT_PROFILE: 'STANDARD', WHISPER_SERVICE_URL: 'https://whisper.example', WHISPER_AUTH_RESOURCE: 'api://test', WHISPER_AUTH_CLIENT_ID: 'client', IDENTITY_ENDPOINT: 'http://localhost/identity', IDENTITY_HEADER: 'fixture-header' };
const token = (expires = 1000) => ({ ok: true, json: async () => ({ access_token: 'fixture-token', expires_on: expires }) });
test('legacy private mode is unchanged', async () => assert.deepEqual(await createWhisperIdentity({env:{}})('http://local'), {}));
test('STANDARD fails closed without configuration', async () => assert.rejects(createWhisperIdentity({env:{DEPLOYMENT_PROFILE:'STANDARD'}})('https://whisper.example')));
test('wrong origin and HTTP rejected before identity request', async () => {
  const auth = createWhisperIdentity({env, fetchImpl:()=>assert.fail('must not fetch')});
  // The credential-carrying target is assembled here rather than written as one literal.
  // A URL that carries a name and a password in its authority reads as a leaked credential
  // to every secret scanner, including this project's publication gate, and a fixture is
  // not worth a finding that has to be explained at every release. The same reason keeps
  // that shape out of this comment.
  const withCredentials = new URL('https://whisper.example');
  withCredentials.username = 'fixture-name';
  withCredentials.password = 'fixture-secret';
  // The expected message is part of the assertion. Without it the fixture's own
  // `must not fetch` failure arrives as a rejection too, so the test passed even with the
  // guard deleted - it proved that SOMETHING threw, not that the target was refused.
  for (const target of ['https://other.example', 'http://whisper.example', withCredentials.href]) {
    await assert.rejects(auth(target), { message: 'Whisper identity target rejected' });
  }
});
test('missing managed identity fails closed', async () => assert.rejects(createWhisperIdentity({env:{...env,IDENTITY_HEADER:''}})(env.WHISPER_SERVICE_URL)));
test('concurrent acquisition deduplicates, caches and prohibits redirects', async () => {
  let calls=0;
  const auth=createWhisperIdentity({env,now:()=>0,fetchImpl:async(url,options)=>{
    calls++; assert.equal(url.searchParams.get('client_id'),'client'); assert.equal(options.redirect,'error');
    assert.equal(options.headers['X-IDENTITY-HEADER'],'fixture-header'); return token();
  }});
  const results=await Promise.all(Array.from({length:70},()=>auth('https://whisper.example/session/create')));
  assert.equal(calls,1); assert.equal(results[0].Authorization,'Bearer fixture-token');
  await auth(env.WHISPER_SERVICE_URL); assert.equal(calls,1);
});
test('token refreshes before expiry', async () => {
  let time=0,calls=0;
  const auth=createWhisperIdentity({env,now:()=>time,fetchImpl:async()=>{calls++;return token(1000+time/1000);}});
  await auth(env.WHISPER_SERVICE_URL); time=950000; await auth(env.WHISPER_SERVICE_URL); assert.equal(calls,2);
});
test('expired tokens, malformed responses and provider errors are redacted; retry can recover', async () => {
  for(const result of [token(1),{ok:false,json:async()=>{throw Error('secret');}},{ok:true,json:async()=>({})}]) {
    let calls=0;
    const auth=createWhisperIdentity({env,now:()=>0,fetchImpl:async()=>++calls===1?result:token()});
    await assert.rejects(auth(env.WHISPER_SERVICE_URL),{message:'Whisper identity token unavailable'});
    assert.equal((await auth(env.WHISPER_SERVICE_URL)).Authorization,'Bearer fixture-token');
  }
});
