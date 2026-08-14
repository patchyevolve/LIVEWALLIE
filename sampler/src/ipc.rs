use std::fs;
use std::io::{self, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};

/// Unix socket server at $XDG_RUNTIME_DIR/live-wallpaper/scene.sock.
/// Newline-delimited JSON. The sampler is the server; the extension is the client.
pub struct IpcServer {
    socket_path: PathBuf,
    clients: Arc<Mutex<Vec<Sender<String>>>>,
}

impl IpcServer {
    pub fn new(runtime_dir: &str) -> io::Result<Self> {
        let dir = PathBuf::from(runtime_dir).join("live-wallpaper");
        fs::create_dir_all(&dir)?;
        let socket_path = dir.join("scene.sock");
        if socket_path.exists() {
            // Stale socket from a previous unclean shutdown.
            let _ = fs::remove_file(&socket_path);
        }
        let listener = UnixListener::bind(&socket_path)?;

        let server = IpcServer {
            socket_path,
            clients: Arc::new(Mutex::new(Vec::new())),
        };

        let clients = server.clients.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                match conn {
                    Ok(stream) => {
                        let (tx, rx) = channel::<String>();
                        clients.lock().unwrap().push(tx);
                        std::thread::spawn(move || {
                            writer_loop(stream, rx);
                        });
                    }
                    Err(e) => {
                        eprintln!("[ipc] accept error: {e}");
                    }
                }
            }
        });

        Ok(server)
    }

    pub fn socket_path(&self) -> &PathBuf {
        &self.socket_path
    }

    /// Broadcast one message to every connected client. Prunes dead writers.
    pub fn publish(&self, message: &str) {
        let mut clients = self.clients.lock().unwrap();
        let mut dead = Vec::new();
        for (i, tx) in clients.iter().enumerate() {
            if tx.send(message.to_string()).is_err() {
                dead.push(i);
            }
        }
        for i in dead.into_iter().rev() {
            clients.remove(i);
        }
    }

    pub fn shutdown(&self) {
        let _ = fs::remove_file(&self.socket_path);
    }
}

fn writer_loop(mut stream: std::os::unix::net::UnixStream, rx: Receiver<String>) {
    loop {
        match rx.try_recv() {
            Ok(msg) => {
                if stream.write_all(msg.as_bytes()).is_err() {
                    return;
                }
                if stream.write_all(b"\n").is_err() {
                    return;
                }
            }
            Err(TryRecvError::Empty) => {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(TryRecvError::Disconnected) => return,
        }
    }
}
