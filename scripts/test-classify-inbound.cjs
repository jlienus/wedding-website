'use strict';
process.env.RSVP_SITE_ORIGIN = 'https://johnanddianaswedding.com';
const a = require('../api/_lib/sms_actions');
const cases = [
  ['stop','stop'],['STOP','stop'],['Stop.','stop'],['unsubscribe','stop'],['cancel','stop'],['quit','stop'],['opt out','stop'],['opt-out','stop'],
  ['start','start'],['START','start'],['unstop','start'],['optin','start'],['opt-in','start'],
  ['help','help'],['HELP','help'],['info','help'],
  ['no','no'],['No','no'],['N','no'],['No thanks','no'],['no thank you','no'],['Not attending','no'],['cant make it','no'],["can't make it",'no'],['decline','no'],
  ['yes','yes'],['Y','yes'],['Yep','yes'],['Yes please','yes'],['going','yes'],['will attend','yes'],
  ['', 'other'],['  ','other'],['maybe','other'],['lol who is this','other'],['can i bring a +1','other']
];
let fails = 0;
for (const [inp, exp] of cases) {
  const got = a.classifyInbound(inp);
  if (got !== exp) { console.log('FAIL', JSON.stringify(inp), 'got=', got, 'expected=', exp); fails++; }
}
console.log('classifyInbound:', cases.length - fails, '/', cases.length, 'passed');
process.exit(fails ? 1 : 0);
