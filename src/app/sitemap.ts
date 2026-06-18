import { type MetadataRoute } from "next";

import { siteConfig } from "@/config/site";

// Policy pages required for payment-gateway activation + indexed for SEO.
const LEGAL_PATHS = [
  "/privacy-policy",
  "/terms",
  "/refund-policy",
  "/shipping-policy",
  "/contact",
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    {
      url: siteConfig.url,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    ...LEGAL_PATHS.map((path) => ({
      url: `${siteConfig.url}${path}`,
      lastModified,
      changeFrequency: "yearly" as const,
      priority: 0.5,
    })),
  ];
}
