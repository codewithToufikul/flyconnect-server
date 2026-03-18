import express from "express";
import type { Application, Request, Response, NextFunction } from "express";
import cors from "cors";
import { AuthRoutes } from "./routes/auth.routes.js";
import { UserRoutes } from "./routes/user.routes.js";
import { ChatRoutes } from "./routes/chat.routes.js";
import { CallRoutes } from "./routes/call.routes.js";

const app: Application = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api/v1/auth", AuthRoutes);
app.use("/api/v1/users", UserRoutes);
app.use("/api/v1/chats", ChatRoutes);
app.use("/api/v1/calls", CallRoutes);

// Health Check
app.get("/", (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "Welcome to FlyConnect Server API",
    status: "healthy",
  });
});

// Global Error Handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  res.status(statusCode).json({
    success: false,
    message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// 404 Handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

export default app;
