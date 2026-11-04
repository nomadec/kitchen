// Test helpers the slices share: the fake runner, the fake clock and a host that ran kitchen init.
export { fakeRunner } from "./fake-runner.ts";
export type { FakeRunner, RecordedCall, ScriptedAnswer, ScriptedCommand } from "./fake-runner.ts";
export { fakeClock } from "./fake-clock.ts";
export type { FakeClock } from "./fake-clock.ts";
export { initialisedHost, LOCAL_HOST_CONFIG, TEST_HOST_CONFIG, TEST_PROGRAM } from "./host.ts";
export type { InitialisedHost, HostOptions } from "./host.ts";
