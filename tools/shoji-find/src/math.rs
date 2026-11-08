//! A small maths evaluator for the search box.
//!
//! It knows `+ - * / % ^`, brackets, `×` and `÷`, the constants `pi` and `e`,
//! and the functions `sqrt abs ln log sin cos tan round floor ceil`.
//! A query counts as maths only when it holds a digit and an operator or a
//! function, so "2026" alone stays a plain search.

/// Returns the result as text, or `None` when the query is not maths.
pub fn evaluate(query: &str) -> Option<String> {
    let query = query.trim();
    if query.is_empty() || !query.bytes().any(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut parser = Parser {
        chars: query.chars().collect(),
        pos: 0,
        used_operator: false,
    };
    let value = parser.expr()?;
    parser.skip_spaces();
    if parser.pos != parser.chars.len() || !parser.used_operator || !value.is_finite() {
        return None;
    }
    Some(format_number(value))
}

/// Prints whole numbers without ".0" and others with up to 10 decimals.
pub fn format_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if value.fract() == 0.0 && value.abs() < 1e15 {
        return format!("{}", value as i64);
    }
    if value.abs() >= 1e15 || value.abs() < 1e-6 {
        return format!("{value:e}");
    }
    let text = format!("{value:.10}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
    used_operator: bool,
}

impl Parser {
    fn skip_spaces(&mut self) {
        while self.pos < self.chars.len() && self.chars[self.pos].is_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<char> {
        self.skip_spaces();
        self.chars.get(self.pos).copied()
    }

    fn eat(&mut self, wanted: char) -> bool {
        if self.peek() == Some(wanted) {
            self.pos += 1;
            return true;
        }
        false
    }

    // expr := term (("+" | "-") term)*
    fn expr(&mut self) -> Option<f64> {
        let mut value = self.term()?;
        loop {
            if self.eat('+') {
                self.used_operator = true;
                value += self.term()?;
            } else if self.eat('-') || self.eat('−') {
                self.used_operator = true;
                value -= self.term()?;
            } else {
                return Some(value);
            }
        }
    }

    // term := unary (("*" | "/" | "%") unary)*
    fn term(&mut self) -> Option<f64> {
        let mut value = self.unary()?;
        loop {
            let op = match self.peek() {
                Some('*') if self.chars.get(self.pos + 1) == Some(&'*') => return Some(value),
                Some(c @ ('*' | '×' | '/' | '÷' | '%')) => c,
                _ => return Some(value),
            };
            self.pos += 1;
            self.used_operator = true;
            let right = self.unary()?;
            value = match op {
                '*' | '×' => value * right,
                '/' | '÷' => value / right,
                _ => value % right,
            };
        }
    }

    // unary := ("-" | "+") unary | power
    fn unary(&mut self) -> Option<f64> {
        if self.eat('-') || self.eat('−') {
            return Some(-self.unary()?);
        }
        if self.eat('+') {
            return self.unary();
        }
        self.power()
    }

    // power := atom (("^" | "**") unary)?   (right to left: 2^3^2 = 2^9)
    fn power(&mut self) -> Option<f64> {
        let base = self.atom()?;
        let is_power = if self.peek() == Some('^') {
            self.pos += 1;
            true
        } else if self.peek() == Some('*') && self.chars.get(self.pos + 1) == Some(&'*') {
            self.pos += 2;
            true
        } else {
            false
        };
        if is_power {
            self.used_operator = true;
            return Some(base.powf(self.unary()?));
        }
        Some(base)
    }

    // atom := number | "(" expr ")" | name | name "(" expr ")"
    fn atom(&mut self) -> Option<f64> {
        let c = self.peek()?;
        if c == '(' {
            self.pos += 1;
            let value = self.expr()?;
            return self.eat(')').then_some(value);
        }
        if c.is_ascii_digit() || c == '.' {
            return self.number();
        }
        if c.is_ascii_alphabetic() {
            return self.name();
        }
        None
    }

    fn number(&mut self) -> Option<f64> {
        let start = self.pos;
        while self.pos < self.chars.len()
            && (self.chars[self.pos].is_ascii_digit() || self.chars[self.pos] == '.')
        {
            self.pos += 1;
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        text.parse().ok()
    }

    fn name(&mut self) -> Option<f64> {
        let start = self.pos;
        while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_alphabetic() {
            self.pos += 1;
        }
        let name: String = self.chars[start..self.pos]
            .iter()
            .collect::<String>()
            .to_lowercase();
        match name.as_str() {
            "pi" => return Some(std::f64::consts::PI),
            "e" => return Some(std::f64::consts::E),
            _ => {}
        }
        if !self.eat('(') {
            return None;
        }
        let arg = self.expr()?;
        if !self.eat(')') {
            return None;
        }
        self.used_operator = true;
        let value = match name.as_str() {
            "sqrt" => arg.sqrt(),
            "abs" => arg.abs(),
            "ln" => arg.ln(),
            "log" => arg.log10(),
            "sin" => arg.sin(),
            "cos" => arg.cos(),
            "tan" => arg.tan(),
            "round" => arg.round(),
            "floor" => arg.floor(),
            "ceil" => arg.ceil(),
            _ => return None,
        };
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::evaluate;

    #[test]
    fn simple_sums() {
        assert_eq!(evaluate("19*4+2").as_deref(), Some("78"));
        assert_eq!(evaluate("1 + 2 * 3").as_deref(), Some("7"));
        assert_eq!(evaluate("(1 + 2) * 3").as_deref(), Some("9"));
        assert_eq!(evaluate("7/2").as_deref(), Some("3.5"));
        assert_eq!(evaluate("10 % 4").as_deref(), Some("2"));
        assert_eq!(evaluate("6 × 7").as_deref(), Some("42"));
        assert_eq!(evaluate("1/3").as_deref(), Some("0.3333333333"));
    }

    #[test]
    fn powers_and_signs() {
        assert_eq!(evaluate("2^10").as_deref(), Some("1024"));
        assert_eq!(evaluate("2**3").as_deref(), Some("8"));
        assert_eq!(evaluate("2^3^2").as_deref(), Some("512"));
        assert_eq!(evaluate("-2^2").as_deref(), Some("-4"));
        assert_eq!(evaluate("-3+5").as_deref(), Some("2"));
    }

    #[test]
    fn functions_and_constants() {
        assert_eq!(evaluate("sqrt(16)").as_deref(), Some("4"));
        assert_eq!(evaluate("2*pi").as_deref(), Some("6.2831853072"));
        assert_eq!(evaluate("log(1000)").as_deref(), Some("3"));
    }

    #[test]
    fn not_maths() {
        assert_eq!(evaluate("2026"), None);
        assert_eq!(evaluate("dolphin"), None);
        assert_eq!(evaluate("pricing 2"), None);
        assert_eq!(evaluate("1/0"), None);
        assert_eq!(evaluate("(1+2"), None);
        assert_eq!(evaluate("foo(2)"), None);
        assert_eq!(evaluate(""), None);
    }
}
