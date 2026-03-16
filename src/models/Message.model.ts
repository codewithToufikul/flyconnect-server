import mongoose, { Schema, Document } from "mongoose";

export enum MessageType {
  TEXT = "text",
  IMAGE = "image",
  VIDEO = "video",
  AUDIO = "audio",
  CALL_LOG = "call_log",
  FILE = "file",
}

export enum MessageStatus {
  SENT = "sent",
  DELIVERED = "delivered",
  READ = "read",
}

export interface IMessage extends Document {
  conversationId: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  content: string;
  contentType: MessageType;
  mediaUrl?: string;
  thumbnailUrl?: string;
  fileSize?: number;
  fileName?: string;
  metadata?: {
    duration?: number;
    width?: number;
    height?: number;
  };
  status: MessageStatus;
  reactions: {
    userId: mongoose.Types.ObjectId;
    emoji: string;
  }[];
  replyTo?: mongoose.Types.ObjectId | IMessage;
  isEdited: boolean;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema: Schema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    contentType: {
      type: String,
      enum: Object.values(MessageType),
      default: MessageType.TEXT,
    },
    mediaUrl: {
      type: String,
    },
    thumbnailUrl: {
      type: String,
    },
    fileSize: {
      type: Number,
    },
    fileName: {
      type: String,
    },
    metadata: {
      duration: Number,
      width: Number,
      height: Number,
    },
    status: {
      type: String,
      enum: Object.values(MessageStatus),
      default: MessageStatus.SENT,
    },
    reactions: [
      {
        userId: {
          type: Schema.Types.ObjectId,
          ref: "User",
        },
        emoji: String,
      },
    ],
    replyTo: {
      type: Schema.Types.ObjectId,
      ref: "Message",
    },
    isEdited: {
      type: Boolean,
      default: false,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for high performance
// Fast retrieval of messages in a specific conversation sorted by time
MessageSchema.index({ conversationId: 1, createdAt: -1 });
MessageSchema.index({ senderId: 1 });

export default mongoose.model<IMessage>("Message", MessageSchema);
