import { classifyLiveness } from './liveness-core.mjs';

const bodyText = `Current Openings

Thanks for checking out our job openings. See something that interests you? Apply here.

Epidemiologist...`;

const result = classifyLiveness({
  status: 200,
  finalUrl: 'https://adventservices.bamboohr.com/careers',
  bodyText: bodyText,
  applyControls: ['Apply here']
});

console.log(result);
