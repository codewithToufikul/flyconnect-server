import type { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { User } from "../models/user.model.js";
import { NotificationService } from "../services/notification.service.js";

const JWT_SECRET = (process.env.ACCESS_TOKEN_SECRET ||
  "fallback_secret") as string;

export class AuthController {
  static async login(req: Request, res: Response) {
    const { number, password } = req.body;
    // console.log(number, password);
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
      //   console.log(user);
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
}
