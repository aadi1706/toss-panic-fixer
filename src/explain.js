// Deterministic two-sentence explanations. Used as the default text and as the fallback
// whenever the AI endpoint is unavailable. Uses only facts the engine produced.

const cr = (n) => `${n} ${n === 1 ? 'credit' : 'credits'}`;
const join = (xs, and) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`);

/**
 * team: fan team, fix: result of fixTeam(), option: one of fix.options, ctx: engine context.
 * Returns exactly two sentences.
 */
export function explainTemplate(team, fix, option, ctx, lang = 'en') {
  const name = (id) => ctx.pool.get(id).name;
  const hi = lang === 'hinglish';
  const outs = fix.out.map(name);
  const ins = option.facts.map((f) => f.in);
  const cName = name(option.captain);
  const vName = name(option.vc);

  let first;
  if (hi) {
    const who = fix.captainOut ? ` (captain ${name(team.captain)} bhi bahar hai)` : fix.vcOut ? ` (vice-captain ${name(team.vc)} bhi bahar hai)` : '';
    first = `${join(outs, 'aur')} playing XI mein nahi hai${who}, toh unke points zero aayenge.`;
  } else {
    const who = fix.captainOut ? ` (including your captain ${name(team.captain)})` : fix.vcOut ? ` (including your vice-captain ${name(team.vc)})` : '';
    first = `${join(outs, 'and')} ${outs.length > 1 ? 'are' : 'is'} not in the playing XI${who}, so ${outs.length > 1 ? 'they' : 'he'} would score zero.`;
  }

  const sameRole = option.facts.every((f) => f.sameRole);
  const roleNote = option.facts.map((f) => `${f.in} (${f.inRole})`);
  let second;
  if (hi) {
    const lead = sameRole ? `Same role ke ${join(ins, 'aur')} ko lao` : `${join(roleNote, 'aur')} ko lao`;
    const cv = option.captainChanged || option.vcChanged
      ? `, captain ${cName} aur vice-captain ${vName} ban jayenge`
      : ', captain aur vice-captain wahi rahenge';
    second = `${lead}: team valid rehti hai, ${option.creditsLeft} credits bachte hain${cv}.`;
  } else {
    const lead = sameRole ? `Swapping in ${join(ins, 'and')} keeps the same roles` : `Swapping in ${join(roleNote, 'and')} is the best valid fit`;
    const cv = option.captainChanged || option.vcChanged
      ? `, and ${cName} (C) with ${vName} (VC) take over the leadership`
      : ', and your captain and vice-captain stay as they are';
    second = `${lead}, leaves ${cr(option.creditsLeft)}${cv}.`;
  }
  return `${first} ${second}`;
}

export function noFixText(team, fix, ctx, lang = 'en') {
  const outs = fix.out.map((id) => ctx.pool.get(id).name);
  return lang === 'hinglish'
    ? `${outs.join(', ')} bahar hain, lekin 100 credit ya role/side limit ki wajah se koi valid swap nahi bana. Kisi mehenge player ko manually hata kar dekho.`
    : `${outs.join(', ')} ${outs.length > 1 ? 'are' : 'is'} out, but no swap keeps the team under 100 credits and within the role and side limits. Try removing a pricier player by hand.`;
}
