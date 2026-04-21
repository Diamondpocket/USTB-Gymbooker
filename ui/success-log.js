export function parseBookingSuccess(text) {
  const message = String(text);
  const partialMatch = message.match(/BOOKING_PARTIAL orderIds=([^\s]+) orderCount=([^\s]+) requestedSlots=([^\n]+)/);
  if (partialMatch) {
    return {
      kind: "partial",
      orderId: partialMatch[1],
      orderCount: partialMatch[2],
      slots: partialMatch[3].trim()
    };
  }

  const multiSuccessMatch = message.match(/BOOKING_SUCCESS orderIds=([^\s]+) orderCount=([^\s]+) slots=([^\n]+)/);
  if (multiSuccessMatch) {
    return {
      kind: "success",
      orderId: multiSuccessMatch[1],
      orderCount: multiSuccessMatch[2],
      slots: multiSuccessMatch[3].trim()
    };
  }

  const singleSuccessMatch = message.match(/BOOKING_SUCCESS orderId=([^\s]+) slots=([^\n]+)/);
  if (!singleSuccessMatch) {
    return null;
  }

  return {
    kind: "success",
    orderId: singleSuccessMatch[1],
    orderCount: "1/1",
    slots: singleSuccessMatch[2].trim()
  };
}
