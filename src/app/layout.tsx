import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
	variable: "--font-archivo",
	subsets: ["latin"],
	weight: ["400", "500", "600", "800"],
});

// Usernames are identifiers, and one-character OCR errors are this app's
// failure mode. Mono makes cortez/coriaz distinguishable at a glance.
const plexMono = IBM_Plex_Mono({
	variable: "--font-plex-mono",
	subsets: ["latin"],
	weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
	title: "Followeder — who doesn't follow you back",
	description:
		"Reads a screen recording of your Instagram followers and following, and names the difference. Runs entirely in your browser.",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en">
			<head>
				<link rel="icon" href="/favicon.svg" type="image/svg+xml"></link>
			</head>
			<body className={`${archivo.variable} ${plexMono.variable} antialiased`}>{children}</body>
		</html>
	);
}
