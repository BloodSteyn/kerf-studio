# Serves Kerf Studio on http://localhost:8787 and opens it in Edge or Chrome.
# Web Serial (USB laser control) needs Chrome or Edge and a localhost or file:// page.
param([int]$Port = 8787, [switch]$NoBrowser)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.json' = 'application/json'; '.ico' = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch { Write-Host "Port $Port is already in use. Run with -Port <number> to pick another."; exit 1 }
$url = "http://localhost:$Port/"
Write-Host "Kerf Studio running at $url  (Ctrl+C to stop)"

if (-not $NoBrowser) {
  $edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  $chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
  if (Test-Path $chrome) { Start-Process $chrome "--app=$url" }
  elseif (Test-Path $edge) { Start-Process $edge "--app=$url" }
  else { Start-Process $url }
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq '') { $rel = 'index.html' }
    $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
    $res = $ctx.Response
    try {
      if ($path.StartsWith($root) -and (Test-Path $path -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($path)
        $ext = [IO.Path]::GetExtension($path).ToLower()
        $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
        $res.Headers.Add('Cache-Control', 'no-cache')
        $res.ContentLength64 = $bytes.Length
        if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
      } else {
        $res.StatusCode = 404
      }
    } catch {
      Write-Host "Request failed: $($_.Exception.Message)"
    } finally {
      try { $res.Close() } catch { }
    }
  }
} finally {
  if ($listener.IsListening) { $listener.Stop() }
}

