import test from "node:test";
import assert from "node:assert/strict";
import { parseBookingSuccess } from "../ui/success-log.js";

test("parseBookingSuccess supports current multi-order success log format", () => {
  assert.deepEqual(
    parseBookingSuccess("[card-a] BOOKING_SUCCESS orderIds=Y26041700016,Y26041700017 orderCount=2/2 slots=Court13@12:00-13:00 + Court18@17:00-18:00"),
    {
      orderId: "Y26041700016,Y26041700017",
      slots: "Court13@12:00-13:00 + Court18@17:00-18:00"
    }
  );
});

test("parseBookingSuccess keeps compatibility with old single-order success log format", () => {
  assert.deepEqual(
    parseBookingSuccess("[card-a] BOOKING_SUCCESS orderId=Y26040900134 slots=Court18@8:00-9:00"),
    {
      orderId: "Y26040900134",
      slots: "Court18@8:00-9:00"
    }
  );
});
