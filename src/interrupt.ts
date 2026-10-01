// The first Ctrl-C lets the cleanup finish. The second Ctrl-C quits at once.
export function trapInterrupt() {
  const controller = new AbortController();
  const onInterrupt = () => {
    if (controller.signal.aborted) process.exit(130);
    process.exitCode = 130;
    controller.abort();
  };
  process.on("SIGINT", onInterrupt);
  return { signal: controller.signal, [Symbol.dispose]: () => void process.off("SIGINT", onInterrupt) };
}
