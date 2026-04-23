import { create } from "@bufbuild/protobuf";

import {
  type Any,
  AnySchema,
  Any_Type,
  Scalar_OctetsSchema,
  Scalar_StringSchema,
  Scalar_Type,
  ScalarSchema,
} from "../../generated/mysqlx_datatypes_pb.ts";

const enc = new TextEncoder();

export function encodeValue(v: unknown): Any {
  if (v === null || v === undefined) {
    return create(AnySchema, {
      type: Any_Type.SCALAR,
      scalar: create(ScalarSchema, { type: Scalar_Type.V_NULL }),
    });
  }
  if (typeof v === "boolean") {
    return create(AnySchema, {
      type: Any_Type.SCALAR,
      scalar: create(ScalarSchema, { type: Scalar_Type.V_BOOL, vBool: v }),
    });
  }
  if (typeof v === "bigint") {
    const scalar =
      v < 0n
        ? create(ScalarSchema, { type: Scalar_Type.V_SINT, vSignedInt: v })
        : create(ScalarSchema, { type: Scalar_Type.V_UINT, vUnsignedInt: v });
    return create(AnySchema, { type: Any_Type.SCALAR, scalar });
  }
  if (typeof v === "number") {
    if (Number.isInteger(v) && Number.isSafeInteger(v)) {
      const scalar =
        v < 0
          ? create(ScalarSchema, { type: Scalar_Type.V_SINT, vSignedInt: BigInt(v) })
          : create(ScalarSchema, { type: Scalar_Type.V_UINT, vUnsignedInt: BigInt(v) });
      return create(AnySchema, { type: Any_Type.SCALAR, scalar });
    }
    return create(AnySchema, {
      type: Any_Type.SCALAR,
      scalar: create(ScalarSchema, { type: Scalar_Type.V_DOUBLE, vDouble: v }),
    });
  }
  if (typeof v === "string") {
    return create(AnySchema, {
      type: Any_Type.SCALAR,
      scalar: create(ScalarSchema, {
        type: Scalar_Type.V_STRING,
        vString: create(Scalar_StringSchema, { value: enc.encode(v) }),
      }),
    });
  }
  if (v instanceof Uint8Array) {
    return create(AnySchema, {
      type: Any_Type.SCALAR,
      scalar: create(ScalarSchema, {
        type: Scalar_Type.V_OCTETS,
        vOctets: create(Scalar_OctetsSchema, { value: v }),
      }),
    });
  }
  if (v instanceof Date) {
    return create(AnySchema, {
      type: Any_Type.SCALAR,
      scalar: create(ScalarSchema, {
        type: Scalar_Type.V_STRING,
        vString: create(Scalar_StringSchema, { value: enc.encode(formatDatetime(v)) }),
      }),
    });
  }
  throw new TypeError(`unsupported parameter type: ${typeof v}`);
}

function formatDatetime(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
