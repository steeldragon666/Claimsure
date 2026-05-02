export * from './types.js';
export { StubRegisterSynthesizer, isoYearWeek } from './stub.js';
export { SonnetRegisterSynthesizer } from './sonnet.js';
export { makeRegisterSynthesizer } from './factory.js';
import './prompts/synthesize-register@1.0.0.js'; // side-effect: register prompt
