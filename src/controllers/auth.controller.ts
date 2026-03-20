import type { Request, Response } from "express";
import axios from "axios";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { User } from "../models/user.model.js";
import { NotificationService } from "../services/notification.service.js";

const JWT_SECRET = (process.env.ACCESS_TOKEN_SECRET ||
  "fallback_secret") as string;

// The FlyBook main-server base URL (configured via env - no hardcoded IPs)
const FLYBOOK_BASE_URL =
  process.env.FLYBOOK_BASE_URL || "http://localhost:3000";

export class AuthController {
  static async login(req: Request, res: Response) {
    const { number, password } = req.body;
    if (!number || !password) {
      return res.status(400).json({
        success: false,
        message: "Number and password are required",
      });
    }

    try {
      // Normalize number format to match FlyBook's flexible search
      let query: any = { number: number };

      if (number.startsWith("+880")) {
        const legacyFormat = "0" + number.slice(4);
        query = { $or: [{ number: number }, { number: legacyFormat }] };
      } else if (number.startsWith("0") && number.length === 11) {
        const internationalFormat = "+880" + number.slice(1);
        query = { $or: [{ number: number }, { number: internationalFormat }] };
      } else if (number.startsWith("880")) {
        const legacyFormat = "0" + number.slice(3);
        const internationalFormat = "+" + number;
        query = {
          $or: [
            { number: number },
            { number: legacyFormat },
            { number: internationalFormat },
          ],
        };
      }

      const user = await User.findOne(query);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Invalid number or password",
        });
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          message: "Invalid number or password",
        });
      }

      const token = jwt.sign(
        {
          id: user._id,
          number: user.number,
          role: user.role,
        },
        JWT_SECRET,
        { expiresIn: "30d" },
      );

      return res.status(200).json({
        success: true,
        message: "Login successful",
        token,
        user: {
          id: user._id,
          name: user.name,
          number: user.number,
          profileImage: user.profileImage,
        },
      });
    } catch (error: any) {
      console.error("Login error:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }

  static async getProfile(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized",
        });
      }

      const user = await User.findById(userId).select("-password");
      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      return res.status(200).json({
        success: true,
        user,
      });
    } catch (error: any) {
      console.error("Get profile error:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }

  static async registerFCMToken(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const { token } = req.body;

      if (!userId || !token) {
        return res.status(400).json({
          success: false,
          message: "User ID and token are required",
        });
      }

      await NotificationService.registerToken(userId, token);

      return res.status(200).json({
        success: true,
        message: "FCM token registered successfully",
      });
    } catch (error: any) {
      console.error("Register FCM token error:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }

  /**
   * SSO Login with FlyBook
   *
   * Flow:
   * 1. FlyConnect app sends the FlyBook JWT token it received via deep link
   * 2. This controller verifies the token against the FlyBook server (Identity Provider)
   * 3. If valid, finds or auto-creates the user in FlyConnect's own DB
   * 4. Syncs profile data from FlyBook (name, profileImage) on each login
   * 5. Issues a FlyConnect JWT token and returns it to the app
   */
  static async loginWithFlyBook(req: Request, res: Response) {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({
        success: false,
        message: "FlyBook token is required",
      });
    }

    try {
      // Step 1: Verify the FlyBook token against the FlyBook server (Identity Provider)
      console.log("🔐 [SSO] Verifying FlyBook token with:", FLYBOOK_BASE_URL);

      let verifyResponse;
      try {
        verifyResponse = await axios.get(
          `${FLYBOOK_BASE_URL}/api/v1/auth/verify-sso-token`,
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000,
          },
        );
      } catch (axiosErr: any) {
        console.error(
          "❌ [SSO] FlyBook server unreachable:",
          axiosErr.message,
        );
        return res.status(503).json({
          success: false,
          message:
            "Could not reach FlyBook server for verification. Make sure the FlyBook server is running.",
        });
      }

      if (!verifyResponse.data?.success) {
        console.warn("⚠️ [SSO] FlyBook token verification failed");
        return res.status(401).json({
          success: false,
          message: "Invalid or expired FlyBook Token",
        });
      }

      const fbUser = verifyResponse.data.user;
      if (!fbUser?.number) {
        return res.status(401).json({
          success: false,
          message: "Incomplete user data received from FlyBook",
        });
      }
      console.log("✅ [SSO] FlyBook token verified for:", fbUser.name);

      // Step 2: Find or create user in FlyConnect Database
      let user = await User.findOne({ number: fbUser.number });

      if (!user) {
        // Auto-register: user exists in FlyBook but not in FlyConnect yet
        console.log(
          "👤 [SSO] User not found locally, auto-registering:",
          fbUser.number,
        );
        user = await User.create({
          name: fbUser.name,
          number: fbUser.number,
          profileImage:
            fbUser.profileImage ||
            "https://i.ibb.co/mcL9L2t/f10ff70a7155e5ab666bcdd1b45b726d.jpg",
          // Random secure password — this user authenticates via SSO only
          password: await bcrypt.hash(
            Math.random().toString(36) + Date.now().toString(36),
            12,
          ),
          role: "user",
        });
        console.log("✅ [SSO] New FlyConnect user created:", user._id);
      } else {
        // Step 3: Sync profile data from FlyBook (keep FlyConnect user up-to-date)
        let updated = false;
        if (fbUser.name && fbUser.name !== user.name) {
          user.name = fbUser.name;
          updated = true;
        }
        if (fbUser.profileImage && fbUser.profileImage !== user.profileImage) {
          user.profileImage = fbUser.profileImage;
          updated = true;
        }
        if (updated) {
          await user.save();
          console.log("🔄 [SSO] User profile synced from FlyBook");
        } else {
          console.log("✅ [SSO] Existing user found:", user._id);
        }
      }

      // Step 4: Issue a FlyConnect JWT Token (entirely separate from the FlyBook token)
      const flyConnectToken = jwt.sign(
        { id: user._id, number: user.number, role: user.role },
        JWT_SECRET,
        { expiresIn: "30d" },
      );

      console.log("🚀 [SSO] FlyConnect token issued for:", user.name);

      return res.status(200).json({
        success: true,
        message: "SSO Login successful",
        token: flyConnectToken,
        user: {
          id: user._id,
          name: user.name,
          number: user.number,
          profileImage: user.profileImage,
        },
      });
    } catch (error: any) {
      console.error("❌ SSO Login Error:", error.message);
      return res.status(500).json({
        success: false,
        message: "SSO Authentication failed. Please try again.",
      });
    }
  }
}
