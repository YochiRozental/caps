import type { MetadataRoute } from "next";
import { SITE_URL, isIndexableSite } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  if (!isIndexableSite()) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/admin",
        "/api/",
        "/profile",
        "/login",
        "/register",
        "/account-status",
        "/complete-profile",
        "/change-password",
        "/staging-login",
        "/payments",
        "/booking/my",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
