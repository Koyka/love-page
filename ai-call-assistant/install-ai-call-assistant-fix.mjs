import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const appPath = path.join(root, 'public', 'app.js');
const htmlPath = path.join(root, 'public', 'index.html');
const workflowPath = path.join(root, 'workflow.json');

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function replaceHandler(source, startMarker, nextMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  ensure(start !== -1, label + ': handler start was not found.');
  const end = source.indexOf(nextMarker, start);
  ensure(end !== -1, label + ': following handler marker was not found.');
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchResponseDone(source) {
  const marker = "  if (event.type === 'response.done') {";
  const start = source.indexOf(marker);
  ensure(start !== -1, 'Response diagnostics: response.done handler was not found.');
  const nextMarker = "  if (event.type === 'error') {";
  const end = source.indexOf(nextMarker, start);
  ensure(end !== -1, 'Response diagnostics: following API error handler was not found.');
  const replacement = [
    "  if (event.type === 'response.done') {",
    '    const response = event.response || {};',
    "    const status = response.status || 'unknown';",
    '    const reason = response.status_details?.reason || response.status_details?.error?.message;',
    '    const transcript = (response.output || [])',
    '      .flatMap((item) => item.content || [])',
    "      .map((part) => part.transcript || part.text || '')",
    '      .filter(Boolean)',
    "      .join(' ');",
    '    const audioTokens = response.usage?.output_token_details?.audio_tokens;',
    "    log('AI response ' + status + (reason ? ' (' + reason + ')' : '') + (transcript ? ' · ' + transcript : '') + (Number.isFinite(audioTokens) ? ' · ' + audioTokens + ' audio tokens' : ''));",
    "    if (status !== 'completed') {",
    '      clearTimeout(audioSafetyTimer);',
    "      if (responseMode === 'speech') {",
    '        setMicEnabled(true);',
    "        $('markCompleteBtn').disabled = !connected;",
    '      }',
    '      responseMode = null;',
    "      $('draftState').textContent = 'Response ' + status + (reason ? ': ' + reason : '');",
    '    }',
    '  }',
    ''
  ].join('\n');
  return source.slice(0, start) + replacement + source.slice(end);
}

async function main() {
  const appOriginal = await fs.readFile(appPath, 'utf8');
  const htmlOriginal = await fs.readFile(htmlPath, 'utf8');
  const workflowOriginal = await fs.readFile(workflowPath, 'utf8');
  const workflow = JSON.parse(workflowOriginal);
  let app = appOriginal;
  let html = htmlOriginal;

  // Accept either the pristine project parser or the user's already-fixed raw SDP parser.
  if (app.includes('const result = await response.json();') && app.includes('result.transport.sdp')) {
    const fetchStart = app.indexOf("const response = await fetch('/api/session'");
    const legacyStart = app.indexOf('    if (!response.ok) {', fetchStart);
    const legacyEndMarker = "\n  } catch (error) {";
    const legacyEnd = app.indexOf(legacyEndMarker, legacyStart);
    ensure(fetchStart !== -1 && legacyStart !== -1 && legacyEnd !== -1,
      'Legacy Realtime parser did not match; no files changed.');
    const end = legacyEnd;
    const replacement = [
      '    const responseText = await response.text();',
      '    if (!response.ok) {',
      '      let message = responseText;',
      '      try {',
      '        const payload = JSON.parse(responseText);',
      '        const detail = payload?.error?.message ?? payload?.error ?? payload?.message;',
      "        message = typeof detail === 'string' ? detail : JSON.stringify(detail ?? payload);",
      '      } catch {}',
      "      throw new Error('OpenAI API returned ' + response.status + ': ' + (message || 'Could not create session.'));",
      '    }',
      '    const answerSdp = responseText.trim();',
      "    if (!answerSdp.startsWith('v=')) {",
      "      throw new Error('OpenAI returned an unexpected WebRTC answer: ' + answerSdp.slice(0, 300));",
      '    }',
      "    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });",
      "    log('Realtime session created. Waiting for audio.');"
    ].join('\n');
    app = app.slice(0, legacyStart) + replacement + app.slice(end);
  } else {
    ensure(app.includes('const answerSdp = responseText.trim();'),
      'Realtime parser is neither the original parser nor the known fixed text/SDP parser; no files changed.');
  }

  // Change only the spoken-audio output token limit, never the text-drafting limit.
  const speechStart = app.indexOf('function speakText(');
  const speechEnd = app.indexOf('\nfunction handleServerEvent', speechStart);
  ensure(speechStart !== -1 && speechEnd !== -1, 'Could not locate speakText() safely; no files changed.');
  let speechBlock = app.slice(speechStart, speechEnd);
  speechBlock = speechBlock.replace(/max_output_tokens:\s*100\s*,/, "max_output_tokens: 'inf',");
  const oldInstruction = "instructions: 'Read the supplied sentence exactly as written in a warm, professional, natural English customer-service voice. Do not alter, extend, or add any words.'";
  const naturalInstruction = "instructions: 'Speak the supplied sentence exactly as written. Sound like a warm, naturally fluent English-speaking customer-service professional on a real phone call, not a narrator or synthetic announcement. Use relaxed conversational intonation, gentle pitch variation, natural emphasis on important words, and short pauses at commas and phrase boundaries. Keep a human, unhurried rhythm. Do not force audible breaths, filler words, laughter, or sighs. Keep every word; do not stop early, paraphrase, extend, or add words.'";
  speechBlock = speechBlock.replace(oldInstruction, naturalInstruction);
  ensure(speechBlock.includes("max_output_tokens: 'inf'") && speechBlock.includes('naturally fluent English-speaking customer-service professional'),
    'Speech output settings did not validate; no files changed.');
  app = app.slice(0, speechStart) + speechBlock + app.slice(speechEnd);

  // Include the actual text/status of every generated voice response in the event log.
  app = patchResponseDone(app);

  const openingReplacement = [
    "$('speakOpeningBtn').addEventListener('click', () => {",
    '  const step = getCurrentStep();',
    '  if (!step) return;',
    "  speakText(step.openingLine, 'Opening line spoken');",
    "  addTranscript('AI · SPOKEN OPENING', step.openingLine);",
    '});',
    ''
  ].join('\n');
  app = replaceHandler(app,
    "$('speakOpeningBtn').addEventListener('click', () => {",
    "$('suggestBtn').addEventListener('click', () => {",
    openingReplacement,
    'Opening-line button');

  const approveReplacement = [
    "$('approveSpeakBtn').addEventListener('click', () => {",
    '  if (!pendingDraft) return;',
    '  const approved = pendingDraft;',
    '  speakText(approved);',
    "  $('approveSpeakBtn').disabled = true;",
    "  $('discardDraftBtn').disabled = true;",
    "  $('draftState').textContent = 'Speaking approved reply';",
    '});',
    ''
  ].join('\n');
  app = replaceHandler(app,
    "$('approveSpeakBtn').addEventListener('click', () => {",
    "$('discardDraftBtn').addEventListener('click', () => {",
    approveReplacement,
    'Approved-reply button');

  const nextStepReplacement = [
    "$('markCompleteBtn').addEventListener('click', () => {",
    '  const step = getCurrentStep();',
    '  if (!step) return;',
    '  currentStep += 1;',
    "  pendingDraft = '';",
    "  currentTranscript = '';",
    "  $('draftText').textContent = 'Waiting for the customer at the new step.';",
    "  $('draftState').textContent = 'Waiting for customer';",
    "  $('approveSpeakBtn').disabled = true;",
    "  $('discardDraftBtn').disabled = true;",
    "  $('suggestBtn').disabled = true;",
    '  renderWorkflow();',
    "  if (getCurrentStep()) log('Supervisor advanced to Step ' + (currentStep + 1) + '.');",
    "  else log('Workflow completed by supervisor.');",
    '});',
    ''
  ].join('\n');
  app = replaceHandler(app,
    "$('markCompleteBtn').addEventListener('click', () => {",
    "$('resetStepBtn').addEventListener('click', () => {",
    nextStepReplacement,
    'Next-step button');

  workflow.voice = 'cedar';
  const updatedWorkflow = JSON.stringify(workflow, null, 2) + '\n';
  html = html.replace('Approve & speak opening line', 'Speak opening line');

  const tempApp = appPath + '.tmp-fix.js';
  const tempHtml = htmlPath + '.tmp-fix';
  const tempWorkflow = workflowPath + '.tmp-fix';
  await fs.writeFile(tempApp, app, 'utf8');
  const checked = spawnSync(process.execPath, ['--check', tempApp], { encoding: 'utf8' });
  if (checked.status !== 0) {
    await fs.rm(tempApp, { force: true });
    throw new Error('JavaScript syntax test failed; originals were not changed:\n' + (checked.stderr || checked.stdout));
  }
  await fs.writeFile(tempHtml, html, 'utf8');
  await fs.writeFile(tempWorkflow, updatedWorkflow, 'utf8');

  // Backups are made before replacing any existing project files.
  for (const [source, backup] of [
    [appPath, appPath + '.before-ai-fix'],
    [htmlPath, htmlPath + '.before-ai-fix'],
    [workflowPath, workflowPath + '.before-ai-fix']
  ]) {
    try { await fs.copyFile(source, backup, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }

  await fs.rename(tempApp, appPath);
  await fs.rename(tempHtml, htmlPath);
  await fs.rename(tempWorkflow, workflowPath);

  console.log('Fix installed successfully.');
  console.log('Removed extra confirmation popups for speaking and advancing steps.');
  console.log('Kept the confirmation for Reset current step.');
  console.log('Raised the spoken-output token limit and enabled response diagnostics.');
  console.log('Set the default voice to Cedar.');
  console.log('Backup copies were saved beside the original files.');
}

main().catch((error) => {
  console.error('Fix not installed: ' + error.message);
  process.exitCode = 1;
});
