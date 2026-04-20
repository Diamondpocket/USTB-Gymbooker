export function parseBookingSuccess(text) {
  const message = String(text);
  const match =
    message.match(/BOOKING_SUCCESS orderIds=([^\s]+) orderCount=[^\s]+ slots=([^\n]+)/) ??
    message.match(/BOOKING_SUCCESS orderId=([^\s]+) slots=([^\n]+)/);

  if (!match) {
    return null;
  }

  return {
    orderId: match[1],
    slots: match[2].trim()
  };
}
