import type { Error as ProtoError } from "../../generated/mysqlx_pb.ts";

export class MysqlError extends Error {
  override name = "MysqlError";
  code: string;
  errno: number;
  sqlState: string;
  sqlMessage: string;
  fatal: boolean;

  constructor(proto: ProtoError) {
    super(proto.msg);
    this.errno = proto.code;
    this.code = `ER_${proto.code}`;
    this.sqlState = proto.sqlState;
    this.sqlMessage = proto.msg;
    this.fatal = proto.severity === 1;
  }
}
