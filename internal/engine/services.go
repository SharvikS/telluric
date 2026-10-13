package engine

import "strings"

// serviceSuffixes maps DNS name suffixes to well-known service keys.
var serviceSuffixes = map[string]string{
	"youtube.com": "youtube", "googlevideo.com": "youtube", "ytimg.com": "youtube", "youtu.be": "youtube", "youtube-nocookie.com": "youtube",
	"google.com": "google", "googleapis.com": "google", "gstatic.com": "google", "1e100.net": "google", "googleusercontent.com": "google",
	"google.co.in": "google", "gmail.com": "google", "googlesyndication.com": "google", "doubleclick.net": "google", "dns.google": "google",
	"cloudflare.com": "cloudflare", "cloudflare-dns.com": "cloudflare", "one.one.one.one": "cloudflare", "cloudflareinsights.com": "cloudflare", "cloudflare-ech.com": "cloudflare",
	"amazonaws.com": "aws", "cloudfront.net": "aws", "awsstatic.com": "aws",
	"azure.com": "azure", "windows.net": "azure", "azureedge.net": "azure",
	"microsoft.com": "microsoft", "live.com": "microsoft", "office.com": "microsoft", "msn.com": "microsoft", "bing.com": "microsoft",
	"windowsupdate.com": "microsoft", "msftconnecttest.com": "microsoft", "office.net": "microsoft", "skype.com": "microsoft",
	"akamai.net": "akamai", "akamaiedge.net": "akamai", "akamaized.net": "akamai", "akamaihd.net": "akamai", "edgekey.net": "akamai", "edgesuite.net": "akamai",
	"fastly.net": "fastly", "fastly.com": "fastly", "fastlylb.net": "fastly",
	"github.com": "github", "githubusercontent.com": "github", "githubassets.com": "github", "github.io": "github", "ghcr.io": "github",
	"discord.com": "discord", "discord.gg": "discord", "discordapp.com": "discord", "discord.media": "discord", "discordapp.net": "discord",
	"spotify.com": "spotify", "scdn.co": "spotify", "spotifycdn.com": "spotify", "spotilocal.com": "spotify",
	"steampowered.com": "steam", "steamcommunity.com": "steam", "steamstatic.com": "steam", "steamcontent.com": "steam", "steamserver.net": "steam", "valvesoftware.com": "steam",
	"netflix.com": "netflix", "nflxvideo.net": "netflix", "nflxso.net": "netflix", "nflximg.net": "netflix", "nflxext.com": "netflix",
	"anthropic.com": "anthropic", "claude.ai": "anthropic", "claude.com": "anthropic",
	"openai.com": "openai", "chatgpt.com": "openai", "oaistatic.com": "openai", "oaiusercontent.com": "openai",
	"facebook.com": "meta", "fbcdn.net": "meta", "instagram.com": "meta", "cdninstagram.com": "meta", "facebook.net": "meta", "meta.com": "meta",
	"whatsapp.net": "whatsapp", "whatsapp.com": "whatsapp",
	"apple.com": "apple", "icloud.com": "apple", "mzstatic.com": "apple", "apple-cloudkit.com": "apple",
	"twitch.tv": "twitch", "ttvnw.net": "twitch", "jtvnw.net": "twitch",
	"reddit.com": "reddit", "redd.it": "reddit", "redditmedia.com": "reddit", "redditstatic.com": "reddit",
	"x.com": "x", "twitter.com": "x", "twimg.com": "x", "t.co": "x",
	"telegram.org": "telegram", "t.me": "telegram",
	"zoom.us": "zoom", "zoom.com": "zoom",
	"slack.com": "slack", "slack-edge.com": "slack", "slack-msgs.com": "slack",
	"amazon.com": "amazon", "amazon.in": "amazon", "media-amazon.com": "amazon", "ssl-images-amazon.com": "amazon",
	"jio.com": "jio", "jiocinema.com": "jio", "jiosaavn.com": "jio",
	"torproject.org": "tor",
}

// serviceForName matches the longest known suffix of a DNS name.
func serviceForName(name string) string {
	name = strings.TrimSuffix(strings.ToLower(name), ".")
	for {
		if s, ok := serviceSuffixes[name]; ok {
			return s
		}
		i := strings.IndexByte(name, '.')
		if i < 0 {
			return ""
		}
		name = name[i+1:]
	}
}

var orgServices = []struct{ needle, svc string }{
	{"google", "google"}, {"cloudflare", "cloudflare"}, {"amazon", "aws"}, {"microsoft", "microsoft"},
	{"akamai", "akamai"}, {"fastly", "fastly"}, {"github", "github"}, {"facebook", "meta"}, {"meta platforms", "meta"},
	{"apple", "apple"}, {"valve", "steam"}, {"netflix", "netflix"}, {"reliance jio", "jio"}, {"anthropic", "anthropic"},
	{"openai", "openai"}, {"discord", "discord"}, {"spotify", "spotify"}, {"twitch", "twitch"}, {"telegram", "telegram"},
	{"zoom video", "zoom"}, {"slack", "slack"}, {"twitter", "x"}, {"x corp", "x"},
}

// serviceForOrg maps an ASN organization ("Google LLC") to a service key.
func serviceForOrg(org string) string {
	o := strings.ToLower(org)
	for _, m := range orgServices {
		if strings.Contains(o, m.needle) {
			return m.svc
		}
	}
	return ""
}
