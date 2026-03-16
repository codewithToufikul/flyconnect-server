import { Server as SocketIOServer } from "socket.io";
import { Server as HTTPServer } from "http";
import jwt from "jsonwebtoken";

const JWT_SECRET = (process.env.ACCESS_TOKEN_SECRET ||
  "fallback_secret") as string;

export class SocketService {
  private static io: SocketIOServer;
  private static userSocketMap = new Map<string, Set<string>>(); // userId -> Set of socketIds

  static init(server: HTTPServer) {
    this.io = new SocketIOServer(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    console.log("📡 Socket.io initialized.");

    // Middleware for Auth
    this.io.use((socket, next) => {
      const token =
        socket.handshake.auth.token || socket.handshake.headers.authorization;

      if (!token) {
        return next(new Error("Authentication error: No token provided"));
      }

      // Handle "Bearer <token>" format
      const actualToken = token.startsWith("Bearer ")
        ? token.split(" ")[1]
        : token;

      try {
        const decoded = jwt.verify(actualToken, JWT_SECRET) as any;
        (socket as any).userId = decoded.id;
        next();
      } catch (err) {
        return next(new Error("Authentication error: Invalid token"));
      }
    });

    this.io.on("connection", async (socket) => {
      const userId = (socket as any).userId;
      if (userId) {
        // Track multiple connections
        if (!this.userSocketMap.has(userId)) {
          this.userSocketMap.set(userId, new Set());
        }
        this.userSocketMap.get(userId)!.add(socket.id);

        console.log(
          `👤 User connected: ${userId} (Socket: ${socket.id}). Total connections: ${this.userSocketMap.get(userId)!.size}`,
        );

        // Only update DB and broadcast if this is the FIRST connection
        if (this.userSocketMap.get(userId)!.size === 1) {
          try {
            const { User } = await import("../models/user.model.js");
            await User.findByIdAndUpdate(userId, {
              isOnline: true,
              lastSeen: new Date(),
            });

            this.io.emit("user_status_change", {
              userId,
              isOnline: true,
              lastSeen: new Date(),
            });
          } catch (err) {
            console.error("Error updating user online status:", err);
          }
        }
        socket.join(userId);
      }

      // Handle Premium Real-time Messaging
      socket.on(
        "send_message",
        async (data: {
          conversationId: string;
          receiverId: string;
          content: string;
          contentType?: string;
          mediaUrl?: string;
          thumbnailUrl?: string;
          fileSize?: number;
          fileName?: string;
          metadata?: any;
          replyTo?: string;
        }) => {
          const {
            conversationId,
            receiverId,
            content,
            contentType = "text",
            mediaUrl,
            thumbnailUrl,
            fileSize,
            fileName,
            metadata,
            replyTo,
          } = data;

          try {
            // 1. Save Message to Database
            const mongoose = (await import("mongoose")).default;
            const { default: MessageModel } =
              await import("../models/Message.model.js");

            const messageData: any = {
              conversationId: new mongoose.Types.ObjectId(conversationId),
              senderId: userId,
              content,
              contentType,
              ...(mediaUrl !== undefined && { mediaUrl }),
              ...(thumbnailUrl !== undefined && { thumbnailUrl }),
              ...(fileSize !== undefined && { fileSize }),
              ...(fileName !== undefined && { fileName }),
              ...(metadata !== undefined && { metadata }),
              ...(replyTo !== undefined && {
                replyTo: new mongoose.Types.ObjectId(replyTo),
              }),
              status: "sent",
            };

            const newMessage = await MessageModel.create(messageData);

            // Populate before emitting
            const populatedMessage = await MessageModel.findById(
              newMessage._id,
            ).populate([
              { path: "senderId", select: "name profileImage" },
              {
                path: "replyTo",
                populate: { path: "senderId", select: "name" },
              },
            ]);

            // 2. Update Conversation (lastMessage and unreadCount)
            const { default: ConversationModel } =
              await import("../models/Conversation.model.js");
            await ConversationModel.findByIdAndUpdate(conversationId, {
              lastMessage: newMessage._id,
              $inc: { [`unreadCount.${receiverId}`]: 1 },
            });

            // 3. Emit real-time message to recipient if connected
            this.io.to(receiverId).emit("receive_message", populatedMessage);
            // Also emit to sender
            socket.emit("receive_message", populatedMessage);

            // 4. Send Push Notification via FCM
            const isOnline = this.isUserOnline(receiverId);
            console.log(`📡 [SocketService] Receiver ${receiverId} status: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
            
            // To debug, we send notification even if online, 
            // the app should handle not showing it if appropriate.
            console.log(`🔔 [SocketService] Triggering push notification attempt for ${receiverId}...`);
            
            try {
              const { NotificationService } =
                await import("./notification.service.js");
              const { User } = await import("../models/user.model.js");
              const sender = await User.findById(userId).select("name profileImage");

              await NotificationService.sendNotification(
                receiverId,
                sender?.name || "New Message",
                content,
                {
                  conversationId,
                  type: "CHAT_MESSAGE",
                  senderId: userId,
                  senderName: sender?.name || "",
                  senderImage: (sender as any)?.profileImage || "",
                },
                contentType,
              );
            } catch (notifyError) {
              console.error(`❌ [SocketService] Notification Error:`, notifyError);
            }
          } catch (error) {
            console.error("Error processing send_message:", error);
            socket.emit("error", { message: "Failed to send message" });
          }
        },
      );

      // Handle Mark as Read / Seen
      socket.on(
        "mark_as_read",
        async (data: { conversationId: string; senderId: string }) => {
          const { conversationId, senderId } = data;
          try {
            const { default: MessageModel } =
              await import("../models/Message.model.js");
            const { default: ConversationModel } =
              await import("../models/Conversation.model.js");

            // 1. Update all messages from the OTHER user in this conversation to 'read'
            await MessageModel.updateMany(
              {
                conversationId,
                senderId: senderId,
                status: { $ne: "read" },
              },
              { $set: { status: "read" } },
            );

            // 2. Clear unread count for current user in this conversation
            await ConversationModel.findByIdAndUpdate(conversationId, {
              $set: { [`unreadCount.${userId}`]: 0 },
            });

            // 3. Notify the OTHER user that their messages were seen
            this.io.to(senderId).emit("messages_seen", {
              conversationId,
              seenBy: userId,
            });

            console.log(
              `👁️ Messages in ${conversationId} marked as read by ${userId}`,
            );
          } catch (error) {
            console.error("Error marking messages as read:", error);
          }
        },
      );

      // Edit Message
      socket.on(
        "edit_message",
        async (data: {
          messageId: string;
          conversationId: string;
          receiverId: string;
          newContent: string;
        }) => {
          const { messageId, receiverId, newContent, conversationId } = data;
          try {
            const { default: MessageModel } =
              await import("../models/Message.model.js");
            const updatedMessage = await MessageModel.findByIdAndUpdate(
              messageId,
              { content: newContent, isEdited: true },
              { new: true },
            );

            if (updatedMessage) {
              this.io.to(receiverId).emit("message_edited", {
                messageId,
                conversationId,
                newContent,
                isEdited: true,
              });
            }
          } catch (error) {
            console.error("Error editing message:", error);
          }
        },
      );

      // Delete Message (Unsent for everyone)
      socket.on(
        "delete_message",
        async (data: {
          messageId: string;
          conversationId: string;
          receiverId: string;
        }) => {
          const { messageId, receiverId, conversationId } = data;
          try {
            const { default: MessageModel } =
              await import("../models/Message.model.js");
            // Soft delete: mark as deleted
            await MessageModel.findByIdAndUpdate(messageId, {
              content: "This message was deleted",
              isDeleted: true,
              mediaUrl: null,
              thumbnailUrl: null,
            });

            this.io.to(receiverId).emit("message_deleted", {
              messageId,
              conversationId,
            });
          } catch (error) {
            console.error("Error deleting message:", error);
          }
        },
      );

      // Message Reaction
      socket.on(
        "message_reaction",
        async (data: {
          messageId: string;
          conversationId: string;
          receiverId: string;
          emoji: string;
        }) => {
          const { messageId, receiverId, emoji, conversationId } = data;
          try {
            const { default: MessageModel } =
              await import("../models/Message.model.js");
            const message = await MessageModel.findById(messageId);

            if (message) {
              const reactions = message.reactions || [];
              // Find any existing reaction from this user
              const existingUserReactionIndex = reactions.findIndex(
                (r: any) => r.userId.toString() === userId,
              );

              if (existingUserReactionIndex > -1) {
                const oldEmoji = reactions[existingUserReactionIndex]?.emoji;
                // remove existing
                reactions.splice(existingUserReactionIndex, 1);

                // If it was a different emoji, add the new one
                if (oldEmoji !== emoji) {
                  reactions.push({ userId, emoji });
                }
              } else {
                // No existing reaction, just add
                reactions.push({ userId, emoji });
              }

              message.reactions = reactions;
              await message.save();

              // Notify recipient
              this.io.to(receiverId).emit("message_reaction_updated", {
                messageId,
                conversationId,
                reactions: message.reactions,
              });
            }
          } catch (error) {
            console.error("Error updating message reaction:", error);
          }
        },
      );

      // Professional Typing Indicator
      socket.on(
        "typing",
        (data: {
          conversationId: string;
          receiverId: string;
          isTyping: boolean;
        }) => {
          const { receiverId, isTyping, conversationId } = data;
          this.io.to(receiverId).emit("user_typing", {
            userId, // The one who is typing
            conversationId,
            isTyping,
          });
        },
      );

      // Handle Signaling (WebRTC for Calls)
      socket.on(
        "call-signal",
        (data: { to: string; signal: any; type: string }) => {
          const { to, signal, type } = data;
          this.io.to(to).emit("call-signal-received", {
            from: userId,
            signal,
            type,
          });
        },
      );

      socket.on("disconnect", async () => {
        if (userId) {
          const userSockets = this.userSocketMap.get(userId);
          if (userSockets) {
            userSockets.delete(socket.id);
            console.log(
              `🔌 Socket disconnected: ${socket.id} for user ${userId}. Remaining: ${userSockets.size}`,
            );

            // Only set offline if NO connections remain
            if (userSockets.size === 0) {
              this.userSocketMap.delete(userId);
              try {
                const { User } = await import("../models/user.model.js");
                const now = new Date();
                await User.findByIdAndUpdate(userId, {
                  isOnline: false,
                  lastSeen: now,
                });

                this.io.emit("user_status_change", {
                  userId,
                  isOnline: false,
                  lastSeen: now,
                });
              } catch (err) {
                console.error("Error updating user offline status:", err);
              }
            }
          }
        }
      });
    });
  }

  static getIO() {
    return this.io;
  }

  static getSocketId(userId: string) {
    return this.userSocketMap.get(userId);
  }

  static isUserOnline(userId: string) {
    const sockets = this.userSocketMap.get(userId);
    return sockets ? sockets.size > 0 : false;
  }
}
