param(
    [string]$HostName = "127.0.0.1",
    [int]$Port = 52002,
    [int]$PauseSeconds = 5,
    [string[]]$FrequenciesKHz = @("7030", "7060", "14060"),
    [string]$Mode = "CW",
    [switch]$Split,
    [switch]$PreserveSplitAndDual,
    [int]$CwTxOffsetHz = 90,
    [switch]$AllowDual,
    [switch]$SuppressModeChange
)

$ErrorActionPreference = "Stop"

function New-AdifField {
    param(
        [string]$Name,
        [string]$Value
    )

    return "<$Name`:$($Value.Length)>$Value"
}

function New-SetFreqModeCommand {
    param(
        [string]$FrequencyKHz,
        [string]$Mode
    )

    $fields = @(
        New-AdifField "xcvrfreq" $FrequencyKHz
        New-AdifField "preservesplitanddual" $(if ($PreserveSplitAndDual) { "Y" } else { "N" })
    )

    if (-not $PreserveSplitAndDual) {
        $fields += New-AdifField "xcvrmode" $Mode
    }

    $parameters = $fields -join ""

    return "$(New-AdifField "command" "CmdSetFreqMode")$(New-AdifField "parameters" $parameters)"
}

function Format-CommanderKHz {
    param([double]$FrequencyKHz)

    return $FrequencyKHz.ToString("0.###", [Globalization.CultureInfo]::InvariantCulture)
}

function New-QsxSplitCommand {
    param([string]$FrequencyKHz)

    $txFrequencyKHz = Format-CommanderKHz ([double]::Parse($FrequencyKHz, [Globalization.CultureInfo]::InvariantCulture) + ($CwTxOffsetHz / 1000))
    $parameters = @(
        New-AdifField "xcvrfreq" $txFrequencyKHz
        New-AdifField "SuppressDual" $(if ($AllowDual) { "N" } else { "Y" })
        New-AdifField "SuppressModeChange" $(if ($SuppressModeChange) { "Y" } else { "N" })
    ) -join ""

    return "$(New-AdifField "command" "CmdQSXSplit")$(New-AdifField "parameters" $parameters)"
}

function Send-CommanderCommand {
    param([string]$Command)

    $client = [Net.Sockets.TcpClient]::new()
    try {
        $connectTask = $client.ConnectAsync($HostName, $Port)
        if (-not $connectTask.Wait(3500)) {
            throw "Timed out connecting to Commander at $HostName`:$Port."
        }

        $bytes = [Text.Encoding]::ASCII.GetBytes($Command)
        $stream = $client.GetStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    }
    finally {
        $client.Close()
    }
}

if ($FrequenciesKHz.Count -eq 0) {
    throw "Provide at least one frequency in kHz."
}

Write-Host "Commander focus repro"
Write-Host "Target: $HostName`:$Port"
Write-Host "Sequence: $($FrequenciesKHz -join ' -> ') kHz $Mode"
Write-Host "Split: $($Split.IsPresent), CW TX offset: $CwTxOffsetHz Hz"
Write-Host "PreserveSplitAndDual: $($PreserveSplitAndDual.IsPresent)"
Write-Host "Set frequency mode field: $(if ($PreserveSplitAndDual) { 'omitted' } else { $Mode })"
Write-Host "SuppressDual: $(-not $AllowDual.IsPresent), SuppressModeChange: $($SuppressModeChange.IsPresent)"
Write-Host "Press Ctrl+C to stop."

$index = 0
while ($true) {
    $frequencyKHz = $FrequenciesKHz[$index % $FrequenciesKHz.Count]
    $time = Get-Date -Format "HH:mm:ss"
    Write-Host "$time set $frequencyKHz kHz $Mode"
    Send-CommanderCommand (New-SetFreqModeCommand $frequencyKHz $Mode)

    if ($Split) {
        $txFrequencyKHz = Format-CommanderKHz ([double]::Parse($frequencyKHz, [Globalization.CultureInfo]::InvariantCulture) + ($CwTxOffsetHz / 1000))
        Write-Host "$time split TX $txFrequencyKHz kHz"
        Send-CommanderCommand (New-QsxSplitCommand $frequencyKHz)
    }

    $index += 1
    Start-Sleep -Seconds $PauseSeconds
}
