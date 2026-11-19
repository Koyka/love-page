import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const appPath = path.join(root, 'public', 'app.js');
const workflowPath = path.join(root, 'workflow.json');
const appBackupPath = `${appPath}.before-ai-fix`;
const workflowBackupPath = `${workflowPath}.before-ai-fix`;

function replaceExactlyOnce(source, oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count === 0 && source.includes(newText)) return source;
  if (count !== 1) {
    throw new Error(`${label}: expected one original code block, found ${count}. No files were changed.`);
  }
  return source.replace(oldText, newText);
}

async function main() {
  let app = await fs.readFile(appPath, 'utf8');
  const workflowText = await fs.readFile(workflowPath, 'utf8');
  let workflow;
  try { workflow = JSON.parse(workflowText); }
  catch { throw new Error('workflow.json is not valid JSON. No files were changed.'); }

  app = replaceExactlyOnce(
    app,
    "      max_output_tokens: 100,\n      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Speak exactly this customer-facing sentence and nothing else. Do not add greetings, explanations, or another question: ${text}` }] }],\n      instructions: 'Read the supplied sentence exactly as written in a warm, professional, natural English customer-service voice. Do not alter, extend, or add any words.'",
    "      max_output_tokens: 'inf',\n      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Speak exactly this customer-facing sentence and nothing else. Do not add greetings, explanations, or another question: ${text}` }] }],\n      instructions: 'Speak the supplied sentence exactly as written. Sound like a warm, naturally fluent English-speaking customer-service professional on a real phone call, not a narrator or a synthetic announcement. Use relaxed conversational intonation, gentle pitch variation, natural emphasis on important words, and short pauses at commas and natural phrase boundaries. Keep a human, unhurried rhythm with subtle breath-like transitions between phrases, but do not force audible breaths, filler words, laughter, or sighs. Keep every word; do not stop early, paraphrase, extend, or add any words.'",
    'Speech length and delivery settings'
  );

  app = replaceExactlyOnce(
    app,
    "  if (event.type === 'response.done') {\n    const status = event.response?.status;\n    if (status && status !== 'completed') {\n      clearTimeout(audioSafetyTimer);\n      if (responseMode === 'speech') { setMicEnabled(true); $('markCompleteBtn').disabled = !connected; }\n      responseMode = null;\n      log(`AI response ended with status: ${status}`);\n    }\n  }",
    "  if (event.type === 'response.done') {\n    const response = event.response || {};\n    const status = response.status || 'unknown';\n    const reason = response.status_details?.reason || response.status_details?.error?.message;\n    const transcript = (response.output || [])\n      .flatMap((item) => item.content || [])\n      .map((part) => part.transcript || part.text || '')\n      .filter(Boolean)\n      .join(' ');\n    const audioTokens = response.usage?.output_token_details?.audio_tokens;\n    log(`AI response ${status}${reason ? ` (${reason})` : ''}${transcript ? ` · ${transcript}` : ''}${Number.isFinite(audioTokens) ? ` · ${audioTokens} audio tokens` : ''}`);\n    if (status !== 'completed') {\n      clearTimeout(audioSafetyTimer);\n      if (responseMode === 'speech') { setMicEnabled(true); $('markCompleteBtn').disabled = !connected; }\n      responseMode = null;\n      $('draftState').textContent = `Response ${status}${reason ? `: ${reason}` : ''}`;\n    }\n  }",
    'Audio diagnostics'
  );

  const legacyRealtimeParser = "    const result = await response.json();";
  if (app.includes(legacyRealtimeParser)) {
    app = replaceExactlyOnce(
      app,
      "    if (!response.ok) {\n      const text = await response.text();\n      let message = text;\n      try { message = JSON.parse(text).error || text; } catch {}\n      throw new Error(message || 'Could not create session.');\n    }\n    const result = await response.json();\n    await peer.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp });\n    log(`Realtime session created (${result.session?.id || 'connected'}).`);",
      "    const responseText = await response.text();\n    if (!response.ok) {\n      let message = responseText;\n      try {\n        const payload = JSON.parse(responseText);\n        const detail = payload?.error?.message ?? payload?.error ?? payload?.message;\n        message = typeof detail === 'string' ? detail : JSON.stringify(detail ?? payload);\n      } catch {}\n      throw new Error(`OpenAI API returned ${response.status}: ${message || 'Could not create session.'}`);\n    }\n    const answerSdp = responseText.trim();\n    if (!answerSdp.startsWith('v=')) {\n      throw new Error('OpenAI returned an unexpected WebRTC answer: ' + answerSdp.slice(0, 300));\n    }\n    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });\n    log('Realtime session created. Waiting for audio.');",
      'Realtime answer parsing'
    );
  } else if (!app.includes('const answerSdp = responseText.trim();')) {
    throw new Error('Realtime answer parser is not the original or verified fixed version. No files were changed.');
  }

  app = replaceExactlyOnce(
    app,
    "$('speakOpeningBtn').addEventListener('click', () => {\n  const step = getCurrentStep();\n  if (step && confirm(`Approve the opening line for Step ${currentStep + 1}?\\n\\n${step.openingLine}`)) {\n    speakText(step.openingLine, 'Opening line approved');\n    addTranscript('AI · APPROVED OPENING', step.openingLine);\n  }\n});",
    "$('speakOpeningBtn').addEventListener('click', () => {\n  const step = getCurrentStep();\n  if (!step) return;\n  speakText(step.openingLine, 'Opening line spoken');\n  addTranscript('AI · SPOKEN OPENING', step.openingLine);\n});",
    'Opening-line confirmation removal'
  );

  app = replaceExactlyOnce(
    app,
    "$('approveSpeakBtn').addEventListener('click', () => {\n  if (!pendingDraft) return;\n  if (confirm(`Approve and speak this reply to the caller?\\n\\n${pendingDraft}`)) {\n    const approved = pendingDraft;\n    speakText(approved);\n    $('approveSpeakBtn').disabled = true;\n    $('discardDraftBtn').disabled = true;\n    $('draftState').textContent = 'Speaking approved reply';\n  }\n});",
    "$('approveSpeakBtn').addEventListener('click', () => {\n  if (!pendingDraft) return;\n  const approved = pendingDraft;\n  speakText(approved);\n  $('approveSpeakBtn').disabled = true;\n  $('discardDraftBtn').disabled = true;\n  $('draftState').textContent = 'Speaking approved reply';\n});",
    'Reply confirmation removal'
  );

  app = replaceExactlyOnce(
    app,
    "$('markCompleteBtn').addEventListener('click', () => {\n  const step = getCurrentStep();\n  if (!step) return;\n  const isLast = currentStep === workflow.steps.length - 1;\n  const prompt = isLast ? 'Confirm that the final step is complete and finish this workflow?' : `Confirm that \"${step.title}\" is complete and move to the next step?`;\n  if (!confirm(prompt)) return;\n  currentStep += 1;",
    "$('markCompleteBtn').addEventListener('click', () => {\n  const step = getCurrentStep();\n  if (!step) return;\n  currentStep += 1;",
    'Step-advance confirmation removal'
  );

  workflow.voice = 'cedar';
  const updatedWorkflowText = JSON.stringify(workflow, null, 2) + '\n';

  const jsCheck = spawnSync(process.execPath, ['--check', appPath], { encoding: 'utf8' });
  if (jsCheck.status !== 0) throw new Error(`JavaScript validation failed before writing:\n${jsCheck.stderr || jsCheck.stdout}`);

  const appTemp = `${appPath}.tmp-ai-fix.js`;
  const workflowTemp = `${workflowPath}.tmp-ai-fix`;
  await fs.writeFile(appTemp, app, 'utf8');
  await fs.writeFile(workflowTemp, updatedWorkflowText, 'utf8');
  const tempCheck = spawnSync(process.execPath, ['--check', appTemp], { encoding: 'utf8' });
  if (tempCheck.status !== 0) {
    await fs.rm(appTemp, { force: true });
    await fs.rm(workflowTemp, { force: true });
    throw new Error(`JavaScript validation failed; originals were not changed:\n${tempCheck.stderr || tempCheck.stdout}`);
  }

  try { await fs.copyFile(appPath, appBackupPath, fs.constants.COPYFILE_EXCL); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  try { await fs.copyFile(workflowPath, workflowBackupPath, fs.constants.COPYFILE_EXCL); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await fs.rename(appTemp, appPath);
  await fs.rename(workflowTemp, workflowPath);

  console.log('AI Call Assistant fix installed successfully.');
  console.log('Updated: public/app.js');
  console.log('Default voice: Cedar');
  console.log('Removed extra confirmation popups for speaking and advancing steps.');
  console.log('Speech output limit: inf; response diagnostics enabled.');
  console.log('Backups: public/app.js.before-ai-fix and workflow.json.before-ai-fix');
  console.log('The Reset current step confirmation is intentionally retained as a destructive-action safeguard.');
}

main().catch((error) => {
  console.error(`Fix not installed: ${error.message}`);
  process.exitCode = 1;
});
