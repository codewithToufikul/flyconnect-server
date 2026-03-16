import { Schema, model } from "mongoose";

const callSchema = new Schema(
  {
    callId: {
      type: String,
      required: true,
      unique: true,
    },
    channelName: {
      type: String,
      required: true,
    },
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
      enum: ["audio", "video"],
      default: "video",
    },
    status: {
      type: String,
      enum: [
        "REQUESTED",
        "RINGING",
        "ACCEPTED",
        "DECLINED",
        "CANCELLED",
        "ENDED",
        "MISSED",
      ],
      default: "REQUESTED",
    },
    startTime: {
      type: Date,
    },
    endTime: {
      type: Date,
    },
    duration: {
      type: Number, // in seconds
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

export default model("Call", callSchema);
