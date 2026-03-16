import mongoose, { Schema, Document } from "mongoose";

export enum CallType {
  AUDIO = "audio",
  VIDEO = "video",
}

export enum CallStatus {
  MISSED = "missed",
  COMPLETED = "completed",
  REJECTED = "rejected",
  BUSY = "busy",
  NO_ANSWER = "no_answer",
}

export interface ICallHistory extends Document {
  callerId: mongoose.Types.ObjectId;
  receiverId: mongoose.Types.ObjectId;
  type: CallType;
  status: CallStatus;
  duration: number; // in seconds
  startedAt: Date;
  endedAt?: Date;
}

const CallHistorySchema: Schema = new Schema(
  {
    callerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receiverId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: Object.values(CallType),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(CallStatus),
      required: true,
    },
    duration: {
      type: Number,
      default: 0,
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    endedAt: {
      type: Date,
    },
  },
  {
    timestamps: false, // We use startedAt/endedAt manually
  },
);

// Indexes
CallHistorySchema.index({ callerId: 1, startedAt: -1 });
CallHistorySchema.index({ receiverId: 1, startedAt: -1 });

export default mongoose.model<ICallHistory>("CallHistory", CallHistorySchema);
