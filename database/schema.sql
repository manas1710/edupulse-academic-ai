CREATE TABLE IF NOT EXISTS Faculties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    roll_number TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    remark TEXT DEFAULT '',
    attendance TEXT DEFAULT '85%',
    submission_status TEXT DEFAULT 'On-time',
    custom_insight TEXT DEFAULT '',
    faculty_id INTEGER,
    UNIQUE(faculty_id, roll_number)
);

CREATE TABLE IF NOT EXISTS Assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    faculty_id INTEGER,
    title TEXT NOT NULL,
    max_marks REAL DEFAULT 100,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(faculty_id) REFERENCES Faculties(id)
);

CREATE TABLE IF NOT EXISTS Marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER,
    assignment_id INTEGER,
    score REAL,
    raw_score REAL,
    max_score REAL DEFAULT 100,
    submission_status TEXT DEFAULT 'On-time',
    FOREIGN KEY(student_id) REFERENCES Students(id),
    FOREIGN KEY(assignment_id) REFERENCES Assignments(id)
);

CREATE TABLE IF NOT EXISTS QuestionBank (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    faculty_id INTEGER,
    title TEXT NOT NULL,
    chapter TEXT DEFAULT '',
    difficulty TEXT DEFAULT 'Moderate',
    questions_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(faculty_id) REFERENCES Faculties(id)
);

