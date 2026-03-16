import "dotenv/config";
import { Server } from "http";
import mongoose from "mongoose";
import app from "./app.js";
import { SocketService } from "./services/socket.service.js";
import { NotificationService } from "./services/notification.service.js";

let server: Server;

const PORT = process.env.PORT || 10000;

async function main() {
  try {
    // Initialize Notification Service
    NotificationService.init();

    const dbUri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ivo4yuq.mongodb.net/flybook?retryWrites=true&w=majority&appName=Cluster0`;

    await mongoose.connect(dbUri);
    console.log("✅ Connected to MongoDB (flybook) Using Mongoose!!");

    server = app.listen(Number(PORT), "0.0.0.0", () => {
      console.log(`🚀 FlyConnect Server is listening on 0.0.0.0:${PORT}`);
      // Initialize Socket.io
      SocketService.init(server);
    });
  } catch (error) {
    console.error("❌ Database connection error:", error);
    process.exit(1);
  }
}

main();
