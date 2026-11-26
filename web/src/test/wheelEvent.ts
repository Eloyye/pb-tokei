/** A wheel event with the fields a browser sends to the gesture handlers. */
export function wheelEvent({ timeStamp, ...init }: WheelEventInit & { timeStamp?: number }) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  // happy-dom's WheelEvent omits the MouseEvent fields.
  Object.defineProperties(event, {
    clientX: { value: init.clientX ?? 0 },
    clientY: { value: init.clientY ?? 0 },
    ctrlKey: { value: init.ctrlKey ?? false },
    shiftKey: { value: init.shiftKey ?? false },
    timeStamp: { value: timeStamp ?? event.timeStamp },
  });
  return event;
}
