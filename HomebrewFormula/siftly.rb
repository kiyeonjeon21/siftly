# Reference formula. The release workflow renders this into the Homebrew tap
# (kiyeonjeon21/homebrew-tap) on each tag, substituting the version and sha256s.
class Siftly < Formula
  desc "Pull HN/YouTube/X/RSS into agent-ready text (CLI + MCP server)"
  homepage "https://github.com/kiyeonjeon21/siftly"
  version "0.0.0"
  license "MIT"

  depends_on "yt-dlp" # for the YouTube source

  on_macos do
    on_arm do
      url "https://github.com/kiyeonjeon21/siftly/releases/download/v#{version}/siftly-darwin-arm64"
      sha256 "REPLACE_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/kiyeonjeon21/siftly/releases/download/v#{version}/siftly-darwin-x64"
      sha256 "REPLACE_DARWIN_X64"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/kiyeonjeon21/siftly/releases/download/v#{version}/siftly-linux-arm64"
      sha256 "REPLACE_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/kiyeonjeon21/siftly/releases/download/v#{version}/siftly-linux-x64"
      sha256 "REPLACE_LINUX_X64"
    end
  end

  def install
    bin.install Dir["siftly-*"].first => "siftly"
  end

  test do
    assert_match "siftly", shell_output("#{bin}/siftly --help")
  end
end
