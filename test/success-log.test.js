import test from "node:test";
import assert from "node:assert/strict";
import { parseBookingSuccess } from "../ui/success-log.js";

test("parseBookingSuccess supports current multi-order success log format", () => {
  assert.deepEqual(
    parseBookingSuccess("[card-a] BOOKING_SUCCESS orderIds=Y26041700016,Y26041700017 orderCount=2/2 slots=Court13@12:00-13:00 + Court18@17:00-18:00"),
    {
      kind: "success",
      orderId: "Y26041700016,Y26041700017",
      orderCount: "2/2",
      slots: "Court13@12:00-13:00 + Court18@17:00-18:00"
    }
  );
});

test("parseBookingSuccess keeps compatibility with old single-order success log format", () => {
  assert.deepEqual(
    parseBookingSuccess("[card-a] BOOKING_SUCCESS orderId=Y26040900134 slots=Court18@8:00-9:00"),
    {
      kind: "success",
      orderId: "Y26040900134",
      orderCount: "1/1",
      slots: "Court18@8:00-9:00"
    }
  );
});

test("parseBookingSuccess recognizes partial booking logs", () => {
  assert.deepEqual(
    parseBookingSuccess("[card-c] BOOKING_PARTIAL orderIds=Y26042100023 orderCount=1/2 requestedSlots=Court3@12:00-13:00 + Court3@17:00-18:00"),
    {
      kind: "partial",
      orderId: "Y26042100023",
      orderCount: "1/2",
      slots: "Court3@12:00-13:00 + Court3@17:00-18:00"
    }
  );
});
