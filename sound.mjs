import { execSync, spawn } from 'child_process';

// Системные WAV-файлы Windows
const WAV_FILES = [
    'C:\\Windows\\Media\\Windows Notify System Generic.wav',
    'C:\\Windows\\Media\\Alarm05.wav',
    'C:\\Windows\\Media\\Alarm01.wav',
    'C:\\Windows\\Media\\notify.wav',
    'C:\\Windows\\Media\\Ring05.wav',
];

function findWav() {
    for (const f of WAV_FILES) {
        try {
            execSync(`if exist "${f}" echo ok`, { shell: 'cmd.exe', stdio: 'pipe' });
            const out = execSync(`if exist "${f}" echo ok`, { shell: 'cmd.exe' }).toString().trim();
            if (out === 'ok') return f;
        } catch { /* skip */ }
    }
    return null;
}

const SET_VOL_TYPE = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class WinVol { [DllImport("winmm.dll")] static extern int waveOutSetVolume(IntPtr h, uint v); public static void Max() { uint v = (uint)(65535 | (65535 << 16)); waveOutSetVolume(IntPtr.Zero, v); } }' -ErrorAction SilentlyContinue`;

function playWav(file) {
    return new Promise((resolve) => {
        const cmd = `${SET_VOL_TYPE}; [WinVol]::Max(); (New-Object System.Media.SoundPlayer '${file}').PlaySync()`;
        const ps = spawn('powershell', [
            '-NoProfile', '-NonInteractive', '-Command', cmd
        ], { stdio: 'ignore', detached: false });
        ps.on('close', resolve);
        setTimeout(resolve, 7000); // таймаут
    });
}

function playBeepVbs() {
    return new Promise((resolve) => {
        // VBScript Beep через mshta — работает даже без консоли
        const script = `mshta vbscript:Execute("Beep:Beep:Beep:window.close")`;
        const ps = spawn('cmd', ['/c', script], { stdio: 'ignore' });
        ps.on('close', resolve);
        setTimeout(resolve, 3000);
    });
}

function playWinApi() {
    return new Promise((resolve) => {
        const ps = spawn('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 1500`
        ], { stdio: 'ignore' });
        ps.on('close', resolve);
        setTimeout(resolve, 4000);
    });
}

export async function playAlert() {
    // Пробуем 3 способа по очереди
    const wav = findWav();
    if (wav) {
        // Проиграть 3 раза с паузой
        for (let i = 0; i < 3; i++) {
            await playWav(wav);
            await new Promise(r => setTimeout(r, 300));
        }
        return;
    }

    // Fallback: системный звук Windows API
    await playWinApi();

    // Fallback: VBScript beep
    await playBeepVbs();
}

// Тест: node sound.mjs
if (process.argv[1].replace(/\\/g, '/').endsWith('sound.mjs')) {
    console.log('Тест звука...');
    const wav = findWav();
    console.log('WAV файл:', wav || 'не найден, используем системный звук');
    await playAlert();
    console.log('Готово!');
}
