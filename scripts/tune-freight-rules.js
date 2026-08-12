/**
 * Tune freight extraction rules against fixture samples.
 * Usage: npm run tune:freight
 */
const samples = require('../src/fixtures/freightEmailSamples');
const { analyzeEmailText } = require('../src/services/freightRules');

function check(sample) {
  const analysis = analyzeEmailText(sample);
  const exp = sample.expect || {};
  const fails = [];

  if (exp.skip) {
    if (analysis.freightRelated) {
      fails.push(
        `expected skip/not-freight but marked freight (score=${analysis.freightScore}, reasons=${(analysis.filterReasons || []).join(',')})`
      );
    }
    return fails;
  }

  if (!analysis.freightRelated) {
    fails.push(
      `expected freight-related (score=${analysis.freightScore}, reasons=${(analysis.filterReasons || []).join(',')})`
    );
  }

  if (exp.partyType && analysis.partyHint.partyType !== exp.partyType) {
    fails.push(`partyType ${analysis.partyHint.partyType} != ${exp.partyType}`);
  }
  if (exp.loadNumber && !analysis.loadNumbers.includes(exp.loadNumber)) {
    fails.push(`loadNumber missing ${exp.loadNumber} (got ${analysis.loadNumbers.join(',') || '—'})`);
  }
  if (exp.status && analysis.statusHit.status !== exp.status) {
    fails.push(`status ${analysis.statusHit.status} != ${exp.status}`);
  }
  if (exp.pickupState && analysis.route.pickup?.state !== exp.pickupState) {
    fails.push(`pickup state ${analysis.route.pickup?.state || '—'} != ${exp.pickupState}`);
  }
  if (exp.deliveryState && analysis.route.delivery?.state !== exp.deliveryState) {
    fails.push(`delivery state ${analysis.route.delivery?.state || '—'} != ${exp.deliveryState}`);
  }
  if (exp.rate != null && !analysis.rates.includes(exp.rate)) {
    fails.push(`rate ${exp.rate} not in [${analysis.rates.join(', ')}]`);
  }
  if (
    exp.equipmentIncludes &&
    !String(analysis.equipment || '')
      .toUpperCase()
      .includes(String(exp.equipmentIncludes).toUpperCase())
  ) {
    fails.push(`equipment ${analysis.equipment || '—'} missing ${exp.equipmentIncludes}`);
  }

  return fails;
}

let passed = 0;
let failed = 0;

for (const sample of samples) {
  const fails = check(sample);
  if (!fails.length) {
    passed += 1;
    const a = analyzeEmailText(sample);
    console.log(
      `PASS  ${sample.id.padEnd(22)} score=${String(a.freightScore || 0).padStart(4)}  ${a.freightRelated ? a.statusHit.status : 'SKIP'}  ${a.partyHint.partyType}`
    );
  } else {
    failed += 1;
    console.log(`FAIL  ${sample.id}`);
    for (const f of fails) console.log(`      - ${f}`);
    const a = analyzeEmailText(sample);
    console.log(
      `      got party=${a.partyHint.partyType} status=${a.statusHit.status} loads=${a.loadNumbers.join('|')} rates=${a.rates.join('|')} route=${a.route.pickup?.raw || ''} -> ${a.route.delivery?.raw || ''} score=${a.freightScore}`
    );
  }
}

console.log(`\n${passed}/${samples.length} passed, ${failed} failed`);
if (failed) process.exit(1);
