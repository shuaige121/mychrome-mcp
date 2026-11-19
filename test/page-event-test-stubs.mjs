// Old VM fixtures exercise ordinary task/input behavior. The P44 side-channel
// effects are inert here; page-event-* tests execute their production bodies.
// Queue admission is deliberately NOT stubbed: extract enterOrdinaryQueue.
const no = () => {};
export const pageEventStubs = Object.freeze({
  beginPageEventTask: no, ensurePageEventTask: no, pinPageEventTarget: no,
  clearPageEventTask: no, preemptPageEvents: no, resumePageObservation: no,
  pageEventControl: no, interruptPagePromptTask: no, publishPageEventStatus: no, pageEventAckContext: () => ({}),
  PAGE_DELIVERY: { nextToolTail: () => null }, pagePromptAuto: null, PAGE_EVENT_SUSPENDED: false,
});
