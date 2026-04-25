param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NativeIconTools
{
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool DestroyIcon(IntPtr handle);
}
"@

function New-RoundedRectanglePath {
  param(
    [System.Drawing.RectangleF]$Rect,
    [float]$Radius
  )

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2
  $path.AddArc($Rect.X, $Rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Rect.X, $Rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Get-PreferredFontFamily {
  foreach ($name in @('Segoe UI Semibold', 'Segoe UI Bold', 'Segoe UI', 'Arial Bold', 'Arial')) {
    $family = New-Object System.Drawing.FontFamily($name)
    if ($family.Name -eq $name) {
      return $family
    }
    $family.Dispose()
  }
  return [System.Drawing.FontFamily]::GenericSansSerif
}

function New-IconBitmap {
  param([int]$Size)

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $outerRect = [System.Drawing.RectangleF]::new(0, 0, $Size - 1, $Size - 1)
  $innerInset = [Math]::Max(10, [int]($Size * 0.04))
  $innerRect = [System.Drawing.RectangleF]::new($innerInset, $innerInset, $Size - ($innerInset * 2), $Size - ($innerInset * 2))
  $outerRadius = [float]($Size * 0.22)
  $innerRadius = [float]($Size * 0.18)

  $outerPath = New-RoundedRectanglePath -Rect $outerRect -Radius $outerRadius
  $innerPath = New-RoundedRectanglePath -Rect $innerRect -Radius $innerRadius

  $shadowOffset = [Math]::Max(8, [int]($Size * 0.035))
  $shadowRect = [System.Drawing.RectangleF]::new($innerRect.X, $innerRect.Y + $shadowOffset, $innerRect.Width, $innerRect.Height)
  $shadowPath = New-RoundedRectanglePath -Rect $shadowRect -Radius $innerRadius
  $shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 3, 7, 18))
  $graphics.FillPath($shadowBrush, $shadowPath)

  $outerBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    [System.Drawing.PointF]::new(0, 0),
    [System.Drawing.PointF]::new($Size, $Size),
    [System.Drawing.Color]::FromArgb(255, 8, 13, 28),
    [System.Drawing.Color]::FromArgb(255, 11, 26, 58)
  )
  $outerBrush.SetBlendTriangularShape(0.62, 0.95)
  $graphics.FillPath($outerBrush, $outerPath)

  $innerBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    [System.Drawing.PointF]::new($innerRect.X, $innerRect.Y),
    [System.Drawing.PointF]::new($innerRect.Right, $innerRect.Bottom),
    [System.Drawing.Color]::FromArgb(255, 20, 167, 216),
    [System.Drawing.Color]::FromArgb(255, 14, 116, 184)
  )
  $graphics.FillPath($innerBrush, $innerPath)

  $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(96, 255, 255, 255)), ([float][Math]::Max(4, $Size * 0.016))
  $graphics.DrawPath($borderPen, $innerPath)

  $fontFamily = Get-PreferredFontFamily
  $fontSize = [float]($Size * 0.34)
  $font = New-Object System.Drawing.Font($fontFamily, $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $textRect = [System.Drawing.RectangleF]::new($Size * 0.10, $Size * 0.19, $Size * 0.80, $Size * 0.56)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center

  $textShadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(76, 3, 7, 18))
  $shadowTextRect = [System.Drawing.RectangleF]::new($textRect.X, $textRect.Y + ($Size * 0.018), $textRect.Width, $textRect.Height)
  $graphics.DrawString('TH', $font, $textShadowBrush, $shadowTextRect, $format)

  $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 247, 250, 255))
  $graphics.DrawString('TH', $font, $textBrush, $textRect, $format)

  $accentPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(190, 231, 245, 255)), ([float][Math]::Max(5, $Size * 0.02))
  $accentPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $accentPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $accentY = [float]($Size * 0.77)
  $graphics.DrawLine($accentPen, $Size * 0.23, $accentY, $Size * 0.77, $accentY)

  $accentDotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
  $dotSize = [float]($Size * 0.05)
  $graphics.FillEllipse($accentDotBrush, $Size * 0.72, $accentY - ($dotSize * 0.75), $dotSize, $dotSize)

  $accentDotBrush.Dispose()
  $accentPen.Dispose()
  $textBrush.Dispose()
  $textShadowBrush.Dispose()
  $format.Dispose()
  $font.Dispose()
  if ($fontFamily -is [System.Drawing.FontFamily]) {
    $fontFamily.Dispose()
  }
  $borderPen.Dispose()
  $innerBrush.Dispose()
  $outerBrush.Dispose()
  $shadowBrush.Dispose()
  $shadowPath.Dispose()
  $innerPath.Dispose()
  $outerPath.Dispose()
  $graphics.Dispose()

  return $bitmap
}

function Save-Png {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [string]$Path
  )

  $dir = Split-Path -Parent $Path
  if ($dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Save-Ico {
  param(
    [System.Drawing.Bitmap]$Bitmap,
    [string]$Path
  )

  $dir = Split-Path -Parent $Path
  if ($dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  $handle = $Bitmap.GetHicon()
  try {
    $icon = [System.Drawing.Icon]::FromHandle($handle)
    try {
      $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
      try {
        $icon.Save($stream)
      } finally {
        $stream.Dispose()
      }
    } finally {
      $icon.Dispose()
    }
  } finally {
    [NativeIconTools]::DestroyIcon($handle) | Out-Null
  }
}

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$resourcesDir = Join-Path $root 'resources'
$buildDir = Join-Path $root 'build'
$linuxIconsDir = Join-Path $buildDir 'icons'

$pngSizes = @(16, 24, 32, 48, 64, 128, 256, 512, 1024)
foreach ($size in $pngSizes) {
  $bitmap = New-IconBitmap -Size $size
  try {
    if ($size -eq 512) {
      Save-Png -Bitmap $bitmap -Path (Join-Path $resourcesDir 'app-icon.png')
      Save-Png -Bitmap $bitmap -Path (Join-Path $buildDir 'icon.png')
    }
    if ($size -le 512) {
      $linuxIconName = '{0}x{0}.png' -f $size
      Save-Png -Bitmap $bitmap -Path (Join-Path $linuxIconsDir $linuxIconName)
    }
  } finally {
    $bitmap.Dispose()
  }
}

$icoBitmap = New-IconBitmap -Size 256
try {
  Save-Ico -Bitmap $icoBitmap -Path (Join-Path $resourcesDir 'app-icon.ico')
  Save-Ico -Bitmap $icoBitmap -Path (Join-Path $buildDir 'icon.ico')
} finally {
  $icoBitmap.Dispose()
}

Write-Host 'Generated TH icon assets in resources/ and build/.'
